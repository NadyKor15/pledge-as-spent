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

// Nova fills a tool's array of objects unreliably (live runs: a leading `{}`, a list made only of
// `{}`, "invalid sequence" errors, all at temperature 0 on the same image), and Nova Pro scrambled a
// positional `a|b|c` format. Lists of strings in `key=value; key=value` form come out reliably, so the
// model sends lines, personal data and classifications as text with one `key=value` entry per line. (An array
// of such strings was still emptied now and then by Nova Lite; one multi-line string was reliable.) The text is parsed
// here and the result goes through the full zod schemas, which are unchanged.

// Nova Pro leaves out nullable top-level fields it has no value for; those arrive as null.
const OPTIONAL_TOP = { merchantAddress: true, country: true, purchasedAt: true, receiptNumber: true, subtotalMinor: true, taxMinor: true, taxIncluded: true } as const;

const ReceiptWire = ParsedReceipt.omit({ lines: true, pii: true }).partial(OPTIONAL_TOP).extend({
  lines: z.string().describe(
    'One line of text per printed receipt line, in print order (separate them with a newline), as "no=1; qty=2; unit=128; amount=256; rate=800; text=<line as printed>; en=<short English name>". Leave out qty, unit and rate when not printed (rate is basis points: 800 for 8 %). amount is negative for a discount. Example: "no=1; qty=2; unit=128; amount=256; rate=800; text=雪解けの水 2L; en=Snowmelt water 2 L"',
  ),
  pii: z.string().describe('One line of text per piece of personal data (separate them with a newline; empty when there is none), as "kind=<card_number|name|phone|address|member_id|other>; box=<x,y,w,h as fractions 0..1 of the image, or leave out>; text=<as printed>". Example: "kind=card_number; box=0.6,0.75,0.23,0.02; text=************1234"'),
});

const ClassificationWire = z.object({
  lines: z.string().min(1).describe(
    'One line of text per receipt line (separate them with a newline), as "no=<lineNo>; need=<needId>; qty=<quantity in the need unit>; verdict=<eligible|rejected|review>; rule=<ruleCode>; conf=<0..1>; why=<one sentence>". Leave out need, qty and rule when they do not apply. Example: "no=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Drinking water counts toward the water need."',
  ),
});

// The model writes "null" or "-" for an empty field more often than nothing at all.
const EMPTY = new Set(["", "null", "none", "n/a", "-"]);
const entries = (t: string) => t.split(/\r?\n/).filter((e) => e.trim() !== "");
const isEmpty = (s: string | undefined) => EMPTY.has((s ?? "").trim().toLowerCase());

const num = (s: string | undefined): number | string | null => {
  if (isEmpty(s)) return null;
  const t = s!.trim();
  const n = Number(t);
  return Number.isNaN(n) ? t : n; // a non-number stays a string so zod rejects it with a clear message
};
const text = (s: string | undefined): string | null => (isEmpty(s) ? null : s!.trim());

/** Splits "key=value; key=value" on the known keys, so a value may itself contain ";" or "=". */
function kv(entry: string, keys: string[], what: string): Record<string, string> {
  const marks = [...entry.matchAll(new RegExp(`(?:^|;)\\s*(${keys.join("|")})\\s*[=:]`, "g"))];
  if (marks.length === 0) throw new ModelOutputError(`${what} "${entry}" has no key=value fields`);
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : entry.length;
    out[m[1]] = entry.slice(m.index! + m[0].length, end).trim();
  });
  return out;
}

export function receiptFromWire(w: z.infer<typeof ReceiptWire>): unknown {
  const lines = entries(w.lines).map((e) => {
    const f = kv(e, ["no", "qty", "unit", "amount", "rate", "text", "en"], "line");
    return { lineNo: num(f.no), qty: num(f.qty), unitPriceMinor: num(f.unit), amountMinor: num(f.amount), taxRateBp: num(f.rate), rawText: f.text ?? "", translationEn: f.en ?? "" };
  });
  const pii = entries(w.pii).map((e) => {
    const f = kv(e, ["kind", "box", "text"], "personal data");
    const b = isEmpty(f.box) ? null : f.box.split(",").map((x) => num(x));
    return { kind: f.kind, bbox: b === null ? null : { x: b[0], y: b[1], w: b[2], h: b[3] }, text: f.text ?? "" };
  });
  const defaults = Object.fromEntries(Object.keys(OPTIONAL_TOP).map((k) => [k, null]));
  return { ...defaults, ...w, lines, pii };
}

export function classificationsFromWire(w: z.infer<typeof ClassificationWire>): unknown {
  return entries(w.lines).map((e) => {
    const f = kv(e, ["no", "need", "qty", "verdict", "rule", "conf", "why"], "classification");
    return { lineNo: num(f.no), needId: text(f.need), needQty: num(f.qty), verdict: f.verdict, ruleCode: text(f.rule), confidence: num(f.conf), reasonEn: f.why ?? "" };
  });
}

async function converseStructured<T>(
  o: Required<Options>,
  args: { what: string; system: string; content: ContentBlock[]; toolName: string; toolDescription: string; wire: z.ZodType; convert: (wire: never) => unknown; schema: z.ZodType<T> },
): Promise<{ value: T; usage: ModelUsage }> {
  const inputSchema = toolSchema(args.wire);
  const textChars = args.system.length + args.content.reduce((s, b) => s + (b.text?.length ?? 0), 0);
  // Nova Lite fails now and then with ModelErrorException ("invalid sequence as part of ToolUse"):
  // the model itself produced a broken tool call. One more attempt, priced and capped like the first.
  let out: ConverseCommandOutput | undefined;
  let usage: ModelUsage | undefined;
  for (let attempt = 1; !out; attempt++) {
    try {
      ({ value: out, usage } = await o.cap.call(
        {
          model: o.modelId,
          what: args.what,
          estimate: {
            textChars,
            toolSpecChars: JSON.stringify({ name: args.toolName, description: args.toolDescription, inputSchema }).length,
            images: args.content.filter((b) => b.image).length,
            maxTokens: o.maxTokens,
          },
        },
        async () => {
          const res = await o.client.send(
            new ConverseCommand({
              modelId: o.modelId,
              system: [{ text: args.system }],
              messages: [{ role: "user", content: args.content }],
              inferenceConfig: { maxTokens: o.maxTokens, temperature: 0 },
              toolConfig: {
                tools: [{ toolSpec: { name: args.toolName, description: args.toolDescription, inputSchema: { json: inputSchema as never } } }],
                toolChoice: { tool: { name: args.toolName } },
              },
            }),
          );
          return { value: res, tokensIn: res.usage?.inputTokens ?? 0, tokensOut: res.usage?.outputTokens ?? 0 };
        },
      ));
    } catch (e) {
      if (attempt >= 2 || (e as Error).name !== "ModelErrorException") throw e;
    }
  }
  if (!usage) throw new Error("unreachable");
  const use = out.output?.message?.content?.find((b) => b.toolUse?.name === args.toolName)?.toolUse;
  if (!use) throw new ModelOutputError(`${args.what}: the model did not call ${args.toolName} (stop reason: ${out.stopReason})`);
  let input: unknown = use.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new ModelOutputError(`${args.what}: tool input is not JSON`);
    }
  }
  const fail = (why: string) => Object.assign(new ModelOutputError(`${args.what}: ${why} (stop reason: ${out.stopReason})`), { usage, raw: input });
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
Rules:
- Call the tool once. Report only what you can see; never guess a missing value (leave it empty or null).
- Every amount is an integer in minor units: whole yen for JPY; hundredths for USD, EUR and TRY (12.50 is 1250). Discounts and coupons are separate lines with a negative amount, placed right after the line they reduce.
- One lines entry per printed product line, in print order, lineNo starting at 1. rawText is the line as printed (join a name that wraps onto two lines); translationEn is a short English name. Copy the Japanese, Turkish or Spanish text exactly.
- qty and unitPriceMinor only when printed; amountMinor is the line total as printed.
- taxRateBp is the rate in basis points when the line shows one (a mark such as ※ or a rate code); otherwise null.
- taxIncluded is true when prices already contain tax, false when tax is added at the end, null when it is not printed. totalMinor is the final amount due.
- purchasedAt is the local date and time as ISO 8601 without a zone (for example 2026-11-05T14:32:00), or null.
- pii lists personal data printed on the receipt (card numbers, personal names, phones, member ids, home addresses) with the text as printed and its box when you can place it.
- readability is "unreadable" when you cannot read the lines, "poor" when parts are doubtful, otherwise "good".`;

export class BedrockNovaReader implements ReceiptReader {
  private readonly o: Required<Options>;
  constructor(opts: Options) {
    this.o = { modelId: NOVA_MODELS.lite, maxTokens: 4096, ...opts };
  }

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    const { value, usage } = await converseStructured(this.o, {
      what: `read receipt (${this.o.modelId})`,
      system: READER_SYSTEM,
      content: [
        { text: `Expected currency: ${hint.currency} (report the currency actually printed). Likely languages: ${hint.languages.join(", ")}.` },
        { image: { format: IMAGE_FORMAT[image.mediaType], source: { bytes: image.bytes } } },
      ],
      toolName: "submit_receipt",
      toolDescription: "Submit the receipt exactly as read from the photo.",
      wire: ReceiptWire,
      convert: receiptFromWire,
      schema: ParsedReceipt,
    });
    return { receipt: value, usage };
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
