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

// Nova Lite fills a tool's array of objects unreliably (live runs: a leading `{}`, a list made only of
// `{}`, or "invalid sequence" errors, all at temperature 0 on the same image). Lists of strings come out
// reliably, so the model sends lines, personal data and classifications as one delimited string each.
// The strings are parsed here and the result goes through the full zod schemas, which are unchanged.

const ReceiptWire = ParsedReceipt.omit({ lines: true, pii: true }).extend({
  lines: z.array(z.string()).describe(
    'One string per printed line, in print order: lineNo|qty|unitPriceMinor|amountMinor|taxRateBp|rawText|translationEn. Leave qty, unitPriceMinor and taxRateBp empty (nothing between the bars) when not printed; taxRateBp is basis points, 800 for 8 %. Discounts have a negative amountMinor. Example: "1|2|128|256|800|雪解けの水 2L|Snowmelt water 2 L"',
  ),
  pii: z.array(z.string()).describe('One string per piece of personal data: kind|x,y,w,h|text. kind is card_number, name, phone, address, member_id or other; x,y,w,h are fractions 0..1 of the image, empty when unknown. Example: "card_number|0.6,0.75,0.23,0.02|************1234"'),
});

const ClassificationWire = z.object({
  lines: z.array(z.string()).describe(
    'One string per receipt line: lineNo|needId|needQty|verdict|ruleCode|confidence|reasonEn. needId, needQty and ruleCode are empty when they do not apply. verdict is eligible, rejected or review. Example: "1|water|6|eligible||0.95|Drinking water counts toward the water need."',
  ),
});

// The model writes "null" or "-" for an empty field more often than nothing at all.
const EMPTY = new Set(["", "null", "none", "n/a", "-"]);
const isEmpty = (s: string | undefined) => EMPTY.has((s ?? "").trim().toLowerCase());

const num = (s: string | undefined): number | string | null => {
  if (isEmpty(s)) return null;
  const t = s!.trim();
  const n = Number(t);
  return Number.isNaN(n) ? t : n; // a non-number stays a string so zod rejects it with a clear message
};
const text = (s: string | undefined): string | null => (isEmpty(s) ? null : s!.trim());

function fields(entry: string, min: number, what: string): string[] {
  const p = entry.split("|");
  if (p.length < min) throw new ModelOutputError(`${what} "${entry}" has ${p.length} fields, expected ${min}`);
  return p;
}

export function receiptFromWire(w: z.infer<typeof ReceiptWire>): unknown {
  const lines = w.lines.map((e) => {
    const p = fields(e, 7, "line");
    const rest = p.slice(5).join("|");
    const cut = rest.lastIndexOf("|"); // translationEn is the last field and has no bar
    return { lineNo: num(p[0]), qty: num(p[1]), unitPriceMinor: num(p[2]), amountMinor: num(p[3]), taxRateBp: num(p[4]), rawText: rest.slice(0, cut).trim(), translationEn: rest.slice(cut + 1).trim() };
  });
  const pii = w.pii.map((e) => {
    const p = fields(e, 3, "personal data");
    const b = isEmpty(p[1]) ? null : p[1].split(",").map((x) => num(x));
    return { kind: p[0].trim(), bbox: b === null ? null : { x: b[0], y: b[1], w: b[2], h: b[3] }, text: p.slice(2).join("|") };
  });
  return { ...w, lines, pii };
}

export function classificationsFromWire(w: z.infer<typeof ClassificationWire>): unknown {
  return w.lines.map((e) => {
    const p = fields(e, 7, "classification");
    return { lineNo: num(p[0]), needId: text(p[1]), needQty: num(p[2]), verdict: p[3].trim(), ruleCode: text(p[4]), confidence: num(p[5]), reasonEn: p.slice(6).join("|").trim() };
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
          text: `Drive rules:\n${input.rules}\n\nNeeds (JSON):\n${JSON.stringify(needs)}\n\nReceipt from ${input.receipt.merchantName} (${input.receipt.currency}). Lines (JSON):\n${JSON.stringify(lines)}`,
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
