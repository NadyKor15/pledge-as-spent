// Amazon Nova readers behind the receipt interfaces. In-Region model IDs only
// (no `us.` inference profiles: AWS credits do not cover cross-Region inference).
// The client is injected so tests never reach AWS; nothing here runs a live call by itself.

import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { CurrencyCode, Need } from "../core/types";
import type { SpendCap } from "./spend";
import { LineClassification, ParsedReceipt, type LineClassifier, type ModelUsage, type ReceiptImage, type ReceiptReader } from "./types";

export const BEDROCK_REGION = "us-east-1";
export const NOVA_MODELS = { lite: "amazon.nova-lite-v1:0", pro: "amazon.nova-pro-v1:0" } as const;

export interface ConverseClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

/** The real client. Credentials come from the usual AWS provider chain; only call this for a live run. */
export function createBedrockClient(region = BEDROCK_REGION): ConverseClient {
  return new BedrockRuntimeClient({ region });
}

/** The model answered, but not in a usable way. Carries what the call cost and what it sent. */
export class ModelOutputError extends Error {
  usage?: ModelUsage;
  raw?: unknown;
}

interface Options {
  client: ConverseClient;
  cap: SpendCap;
  modelId?: string;
  maxTokens?: number;
}

function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// What live runs showed about Nova and structured output (hero and v1 receipts, temperature 0):
// - a tool whose input has an array of objects came back with `{}` entries, or only `{}`, now and then
//   (Lite and Pro), and as service errors "invalid sequence as part of ToolUse", mostly on Japanese;
// - a positional `a|b|c` string per line was scrambled by Pro;
// - a plain-text answer in `key=value; key=value` form, one row per line, came back reliably.
// So the reader answers in plain text, and the classifier (English only) in a tool with one multi-line
// string. Both are parsed here and the result goes through the full zod schemas, which are unchanged.

// The model writes "null" or "-" for an empty field more often than nothing at all.
const EMPTY = new Set(["", "null", "none", "n/a", "-"]);
const isEmpty = (s: string | undefined) => EMPTY.has((s ?? "").trim().toLowerCase());
const entries = (t: string) => t.split(/\r?\n/).filter((e) => e.trim() !== "");

const num = (s: string | undefined): number | string | null => {
  if (isEmpty(s)) return null;
  const n = Number(s!.trim());
  return Number.isNaN(n) ? s!.trim() : n; // a non-number stays a string so zod rejects it with a clear message
};
const text = (s: string | undefined): string | null => (isEmpty(s) ? null : s!.trim());

/**
 * An amount as minor units. Symbols and spaces are dropped. A plain integer is taken as minor units, as the
 * prompt asks. A decimal written the way people print money ("1.49", "0,59", "-1.20") is converted with the
 * currency's exponent; anything else stays unparsed and fails validation.
 */
export function minorUnits(s: string | undefined, exponent: number): number | string | null {
  if (isEmpty(s)) return null;
  const raw = s!.trim();
  const t = raw.replace(/\u2212/g, "-").replace(/[¥￥$€₺£円\s]|\b(JPY|USD|EUR|TRY|TL)\b/gi, "");
  if (!/^[+-]?[\d.,]*\d$/.test(t)) return raw;
  if (exponent === 0) {
    const n = Number(/^[+-]?\d{1,3}([.,]\d{3})+$/.test(t) ? t.replace(/[.,]/g, "") : t);
    return Number.isNaN(n) ? raw : n;
  }
  const dec = t.match(/^([+-]?)([\d.,]*)[.,](\d{2})$/);
  if (dec) return Number(`${dec[1]}${dec[2].replace(/[.,]/g, "") || "0"}${dec[3]}`);
  const n = Number(t);
  return Number.isNaN(n) ? raw : n;
}

/** Splits "key=value; key=value" on the known keys, so a value may itself contain ";" or "=". */
function kv(entry: string, keys: string[]): Record<string, string> | null {
  const marks = [...entry.matchAll(new RegExp(`(?:^|;)\\s*(${keys.join("|")})\\s*[=:]`, "gi"))];
  if (marks.length === 0) return null;
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : entry.length;
    out[m[1].toLowerCase()] = entry.slice(m.index! + m[0].length, end).trim();
  });
  return out;
}

const PII_KINDS = new Set(["card_number", "name", "phone", "address", "member_id", "other"]);
const bool = (s: string | undefined) => (isEmpty(s) ? null : /^(true|yes)$/i.test(s!.trim()) ? true : /^(false|no)$/i.test(s!.trim()) ? false : s!.trim());

/**
 * The reader's plain-text answer to a receipt-shaped object (not yet validated). A line without an amount
 * is not a product line (the model adds SUBTOTAL, TOTAL, card rows) and is left out; line numbers are the
 * position among the lines kept; a personal-data row that cannot be understood is left out.
 */
export function receiptFromText(answer: string): unknown {
  const rows = answer.split(/\r?\n/).map((r) => r.replace(/^[\s*•-]+/, "").trim());
  const head = rows.map((r) => r.match(/^RECEIPT\s*:\s*(.*)$/i)?.[1]).find((r) => r !== undefined);
  if (head === undefined) throw new ModelOutputError("the answer has no RECEIPT row");
  const top = kv(head, ["merchant", "address", "country", "currency", "purchased", "number", "subtotal", "tax", "tax_included", "total", "readability"]) ?? {};
  const exp = (top.currency ?? "").trim().toUpperCase() === "JPY" ? 0 : 2;
  const lines = rows
    .map((r) => r.match(/^LINE\s*:\s*(.*)$/i)?.[1])
    .filter((r): r is string => r !== undefined)
    .map((r) => kv(r, ["no", "qty", "unit", "amount", "rate", "text", "en"]) ?? {})
    .filter((f) => !isEmpty(f.amount))
    .map((f, i) => ({ lineNo: i + 1, qty: num(f.qty), unitPriceMinor: minorUnits(f.unit, exp), amountMinor: minorUnits(f.amount, exp), taxRateBp: num(f.rate), rawText: f.text ?? "", translationEn: f.en ?? "" }));
  const pii = rows
    .map((r) => r.match(/^PII\s*:\s*(.*)$/i)?.[1])
    .filter((r): r is string => r !== undefined)
    .map((r) => kv(r, ["kind", "box", "text"]))
    .filter((f): f is Record<string, string> => f !== null && !isEmpty(f.text))
    .map((f) => {
      const b = isEmpty(f.box) ? null : f.box.split(",").map((x) => num(x));
      const kind = (f.kind ?? "").trim().toLowerCase();
      return { kind: PII_KINDS.has(kind) ? kind : "other", bbox: b === null ? null : { x: b[0], y: b[1], w: b[2], h: b[3] }, text: f.text };
    });
  return {
    merchantName: text(top.merchant),
    merchantAddress: text(top.address),
    country: text(top.country),
    currency: text(top.currency)?.toUpperCase() ?? null,
    purchasedAt: text(top.purchased),
    receiptNumber: text(top.number),
    lines,
    subtotalMinor: minorUnits(top.subtotal, exp),
    taxMinor: minorUnits(top.tax, exp),
    taxIncluded: bool(top.tax_included),
    totalMinor: minorUnits(top.total, exp),
    pii,
    readability: text(top.readability)?.toLowerCase() ?? null,
  };
}

const ClassificationWire = z.object({
  lines: z.string().min(1).describe(
    'One line of text per receipt line (separate them with a newline), as "no=<lineNo>; need=<needId>; qty=<quantity in the need unit>; verdict=<eligible|rejected|review>; rule=<ruleCode>; conf=<0..1>; why=<one sentence>". Leave out need, qty and rule when they do not apply. Example: "no=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Drinking water counts toward the water need."',
  ),
});

export function classificationsFromWire(w: z.infer<typeof ClassificationWire>): unknown {
  return entries(w.lines).map((e) => {
    const f = kv(e, ["no", "need", "qty", "verdict", "rule", "conf", "why"]);
    if (!f) throw new ModelOutputError(`classification "${e}" has no key=value fields`);
    return { lineNo: num(f.no), needId: text(f.need), needQty: num(f.qty), verdict: f.verdict, ruleCode: text(f.rule), confidence: num(f.conf), reasonEn: f.why ?? "" };
  });
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One Converse call through the spend cap, with one more attempt after the model's own broken tool call. */
async function converse(o: Required<Options>, args: { what: string; system: string; content: ContentBlock[]; tool?: Tool }) {
  const textChars = args.system.length + args.content.reduce((s, b) => s + (b.text?.length ?? 0), 0);
  for (let attempt = 1; ; attempt++) {
    try {
      const { value: out, usage } = await o.cap.call(
        {
          model: o.modelId,
          what: args.what,
          estimate: { textChars, toolSpecChars: args.tool ? JSON.stringify(args.tool).length : 0, images: args.content.filter((b) => b.image).length, maxTokens: o.maxTokens },
        },
        async () => {
          const res = await o.client.send(
            new ConverseCommand({
              modelId: o.modelId,
              system: [{ text: args.system }],
              messages: [{ role: "user", content: args.content }],
              inferenceConfig: { maxTokens: o.maxTokens, temperature: 0 },
              ...(args.tool && {
                toolConfig: {
                  tools: [{ toolSpec: { name: args.tool.name, description: args.tool.description, inputSchema: { json: args.tool.inputSchema as never } } }],
                  toolChoice: { tool: { name: args.tool.name } },
                },
              }),
            }),
          );
          return { value: res, tokensIn: res.usage?.inputTokens ?? 0, tokensOut: res.usage?.outputTokens ?? 0 };
        },
      );
      return { out, usage };
    } catch (e) {
      // Nova now and then fails with ModelErrorException ("invalid sequence as part of ToolUse").
      if (attempt >= 2 || (e as Error).name !== "ModelErrorException") throw e;
    }
  }
}

const fails = (what: string, stop: unknown, usage: ModelUsage, raw: unknown) => (why: string) =>
  Object.assign(new ModelOutputError(`${what}: ${why} (stop reason: ${stop})`), { usage, raw });

async function converseStructured<T>(
  o: Required<Options>,
  args: { what: string; system: string; content: ContentBlock[]; toolName: string; toolDescription: string; wire: z.ZodType; convert: (wire: never) => unknown; schema: z.ZodType<T> },
): Promise<{ value: T; usage: ModelUsage }> {
  const { out, usage } = await converse(o, { ...args, tool: { name: args.toolName, description: args.toolDescription, inputSchema: toolSchema(args.wire) } });
  const use = out.output?.message?.content?.find((b) => b.toolUse?.name === args.toolName)?.toolUse;
  if (!use) throw fails(args.what, out.stopReason, usage, undefined)(`the model did not call ${args.toolName}`);
  let input: unknown = use.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw fails(args.what, out.stopReason, usage, input)("tool input is not JSON");
    }
  }
  const fail = fails(args.what, out.stopReason, usage, input);
  const wire = args.wire.safeParse(input);
  if (!wire.success) throw fail(`output does not match the tool schema: ${z.prettifyError(wire.error)}`);
  let converted: unknown;
  try {
    converted = args.convert(wire.data as never);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
  const parsed = args.schema.safeParse(converted);
  if (!parsed.success) throw fail(`output does not match the schema: ${z.prettifyError(parsed.error)}`);
  return { value: parsed.data, usage };
}

const IMAGE_FORMAT = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;

export const READER_SYSTEM = `You read photos of store receipts for a disaster-relief fundraiser and report exactly what is printed.
Answer in plain text only, nothing else, in this form (one row per line; leave a key out when it is not printed; never guess):
RECEIPT: merchant=<store name>; address=<store address>; country=<2-letter code>; currency=<ISO code>; purchased=<YYYY-MM-DDTHH:MM:SS>; number=<receipt number>; subtotal=<amount>; tax=<tax amount>; tax_included=<true or false>; total=<final amount due>; readability=<good, poor or unreadable>
LINE: no=<n>; qty=<quantity>; unit=<unit price>; amount=<line total>; rate=<tax rate in basis points>; text=<line as printed>; en=<short English name>
PII: kind=<card_number, name, phone, address, member_id or other>; box=<x,y,w,h as fractions 0..1 of the image>; text=<as printed>
Rules:
- One LINE row per printed product or discount line, in print order. Do not make rows for subtotal, tax, total, payment or card rows. Copy the Japanese, Turkish or Spanish text exactly; join a name that wraps onto two printed rows.
- Amounts are integers in minor units: whole yen for JPY; hundredths for USD, EUR and TRY (12.50 is 1250). A discount or coupon is its own LINE row with a negative amount, right after the line it reduces.
- rate is 800 for 8 %, 1000 for 10 %; leave it out when the line shows no rate. tax_included is true when prices already contain tax, false when tax is added at the end.
- PII rows are personal data printed on the receipt (card numbers, personal names, phones, member ids, home addresses); leave box out when you cannot place it.
- readability is unreadable when you cannot read the lines, poor when parts are doubtful, otherwise good.
Example:
RECEIPT: merchant=ミナト生活館 北空店; address=空川県北空市港町2-8-1; country=JP; currency=JPY; purchased=2026-11-05T14:32:00; number=8258; subtotal=1700; tax=124; tax_included=true; total=1700; readability=good
LINE: no=1; qty=2; unit=128; amount=256; rate=800; text=雪解けの水 2L; en=Snowmelt water 2 L
LINE: no=2; unit=1444; amount=1444; rate=1000; text=毛布; en=Blanket
PII: kind=card_number; box=0.6,0.75,0.23,0.02; text=************1234`;

export class BedrockNovaReader implements ReceiptReader {
  private readonly o: Required<Options>;
  constructor(opts: Options) {
    this.o = { modelId: NOVA_MODELS.lite, maxTokens: 4096, ...opts };
  }

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    const what = `read receipt (${this.o.modelId})`;
    const { out, usage } = await converse(this.o, {
      what,
      system: READER_SYSTEM,
      content: [
        { text: `Expected currency: ${hint.currency} (report the currency actually printed). Likely languages: ${hint.languages.join(", ")}.` },
        { image: { format: IMAGE_FORMAT[image.mediaType], source: { bytes: image.bytes } } },
      ],
    });
    const answer = (out.output?.message?.content ?? []).map((b) => b.text ?? "").join("\n");
    const fail = fails(what, out.stopReason, usage, answer);
    if (out.stopReason === "max_tokens") throw fail("the answer was cut off");
    let obj: unknown;
    try {
      obj = receiptFromText(answer);
    } catch (e) {
      throw fail(e instanceof Error ? e.message : String(e));
    }
    const parsed = ParsedReceipt.safeParse(obj);
    if (!parsed.success) throw fail(`output does not match the schema: ${z.prettifyError(parsed.error)}`);
    return { receipt: parsed.data, usage };
  }
}

export const CLASSIFIER_SYSTEM = `You match receipt lines to the needs of a disaster-relief drive and apply its rules. You never compute or change money.
For every line (including discount lines, which follow the line they reduce) give one answer:
- verdict "eligible": the product is one of the listed needs and no rule forbids it. needId is that need's id; needQty is how many of the need's unit this line brings (a case of 6 bottles for a "bottle" need counts 6; 2 packs of diapers count 2).
- verdict "rejected": a rule forbids it. needId null, needQty null; ruleCode "alcohol", "tobacco" or "gift_card" for those, "not_in_needs" when it matches no need, "other_rule" for any other rule of the drive.
- verdict "review": you cannot tell. ruleCode "unclear". Prefer review to a guess.
reasonEn is one plain sentence a donor can read. confidence is your own 0..1 certainty.`;

export class BedrockNovaClassifier implements LineClassifier {
  private readonly o: Required<Options>;
  constructor(opts: Options) {
    this.o = { modelId: NOVA_MODELS.pro, maxTokens: 4096, ...opts };
  }

  async classify(input: { receipt: ParsedReceipt; needs: Need[]; rules: string }) {
    const needs = input.needs.map((n) => ({ id: n.id, label: n.label, unit: n.unit, qtyNeeded: n.qtyNeeded }));
    const lines = input.receipt.lines.map((l) => ({ lineNo: l.lineNo, rawText: l.rawText, translationEn: l.translationEn, qty: l.qty, amountMinor: l.amountMinor }));
    const { value, usage } = await converseStructured(this.o, {
      what: `classify lines (${this.o.modelId})`,
      system: CLASSIFIER_SYSTEM,
      content: [
        {
          text: `Drive rules:\n${input.rules}\n\nNeeds (JSON):\n${JSON.stringify(needs)}\n\nReceipt from ${input.receipt.merchantName} (${input.receipt.currency}). Lines (JSON):\n${JSON.stringify(lines)}\n\nAnswer for every one of the ${lines.length} lines: ${lines.length} entries, one per lineNo.`,
        },
      ],
      toolName: "submit_classifications",
      toolDescription: "Submit one classification per receipt line.",
      wire: ClassificationWire,
      convert: classificationsFromWire,
      schema: z.array(LineClassification),
    });
    return { lines: value, usage };
  }
}
