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

export class ModelOutputError extends Error {}

interface Options {
  client: ConverseClient;
  cap: SpendCap;
  modelId?: string;
  maxTokens?: number;
}

function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}

async function converseStructured<T>(
  o: Required<Options>,
  args: { what: string; system: string; content: ContentBlock[]; toolName: string; toolDescription: string; schema: z.ZodType<T> },
): Promise<{ value: T; usage: ModelUsage }> {
  const inputSchema = toolSchema(args.schema);
  const textChars = args.system.length + args.content.reduce((s, b) => s + (b.text?.length ?? 0), 0);
  const { value: out, usage } = await o.cap.call(
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
  );
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
  const parsed = args.schema.safeParse(input);
  if (!parsed.success) {
    throw new ModelOutputError(`${args.what}: output does not match the schema (stop reason: ${out.stopReason}): ${z.prettifyError(parsed.error)}`);
  }
  return { value: parsed.data, usage };
}

const IMAGE_FORMAT = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;

export const READER_SYSTEM = `You read photos of store receipts for a disaster-relief fundraiser and report exactly what is printed.
Rules:
- Call the tool once. Report only what you can see; never guess a missing value, use null instead.
- Every amount is an integer in minor units: whole yen for JPY; hundredths for USD, EUR and TRY (12.50 is 1250). Discounts and coupons are separate lines with a negative amount, placed right after the line they reduce.
- One entry per printed product line, in print order, lineNo starting at 1. rawText is the line as printed (join a name that wraps onto two lines); translationEn is a short English name.
- qty and unitPriceMinor only when printed; amountMinor is the line total as printed.
- taxRateBp is the rate in basis points when the line shows one (a mark such as ※ or a rate code); otherwise null.
- taxIncluded is true when prices already contain tax, false when tax is added at the end, null when it is not printed. totalMinor is the final amount due.
- purchasedAt is the local date and time as ISO 8601 without a zone (for example 2026-11-05T14:32:00), or null.
- pii lists personal data printed on the receipt (card numbers, personal names, phones, member ids, home addresses) with the text as printed and a bbox (x, y, w, h as fractions 0..1 of the image) when you can place it.
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
      schema: z.object({ lines: z.array(LineClassification) }),
    });
    return { lines: value.lines, usage };
  }
}
