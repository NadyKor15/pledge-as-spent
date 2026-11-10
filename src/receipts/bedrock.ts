// Amazon Nova readers behind the receipt interfaces. In-Region model IDs only
// (no `us.` inference profiles: AWS credits do not cover cross-Region inference).
// The client is injected so tests never reach AWS; nothing here runs a live call by itself.

import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { CurrencyCode, Need } from "../core/types";
import type { SpendCap } from "./spend";
import { LineClassification, ParsedReceipt, type LineClassifier, type ModelUsage, type ReceiptImage, type ReceiptReader } from "./types";
import { ClassificationWire, classificationsFromWire, CLASSIFIER_SYSTEM, ModelOutputError, READER_SYSTEM, receiptFromText } from "./wire";

export { kv, minorUnits, ModelOutputError, READER_SYSTEM, receiptFromText } from "./wire";

export const BEDROCK_REGION = "us-east-1";
export const NOVA_MODELS = { lite: "amazon.nova-lite-v1:0", pro: "amazon.nova-pro-v1:0" } as const;

export interface ConverseClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

/** The real client. Credentials come from the usual AWS provider chain; only call this for a live run. */
export function createBedrockClient(region = BEDROCK_REGION): ConverseClient {
  return new BedrockRuntimeClient({ region });
}


export interface Options {
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



interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One Converse call through the spend cap, with one more attempt after the model's own broken tool call. */
export async function converse(o: Required<Options>, args: { what: string; system: string; content: ContentBlock[]; tool?: Tool }) {
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
          const known = res.usage?.inputTokens !== undefined && res.usage?.outputTokens !== undefined;
          return { value: res, tokensIn: known ? res.usage!.inputTokens! : null, tokensOut: known ? res.usage!.outputTokens! : null };
        },
      );
      return { out, usage };
    } catch (e) {
      // Nova now and then fails with ModelErrorException ("invalid sequence as part of ToolUse").
      if (attempt >= 2 || (e as Error).name !== "ModelErrorException") throw e;
    }
  }
}

export const fails = (what: string, stop: unknown, usage: ModelUsage, raw: unknown) => (why: string) =>
  Object.assign(new ModelOutputError(`${what}: ${why} (stop reason: ${stop})`), { usage, raw });

async function converseStructured<T>(
  o: Required<Options>,
  args: { what: string; system: string; content: ContentBlock[]; toolName: string; toolDescription: string; wire: z.ZodType; convert: (wire: never) => unknown; schema: z.ZodType<T>; merge?: (inputs: unknown[]) => unknown },
): Promise<{ value: T; usage: ModelUsage }> {
  const { out, usage } = await converse(o, { ...args, tool: { name: args.toolName, description: args.toolDescription, inputSchema: toolSchema(args.wire) } });
  const uses = (out.output?.message?.content ?? []).filter((b) => b.toolUse?.name === args.toolName).map((b) => b.toolUse!);
  if (uses.length === 0) throw fails(args.what, out.stopReason, usage, undefined)(`the model did not call ${args.toolName}`);
  const inputs = uses.map((use) => {
    if (typeof use.input !== "string") return use.input as unknown;
    try {
      return JSON.parse(use.input) as unknown;
    } catch {
      throw fails(args.what, out.stopReason, usage, use.input)("tool input is not JSON");
    }
  });
  // Nova Pro now and then calls the tool once per receipt line instead of once with every line.
  const input = args.merge && inputs.length > 1 ? args.merge(inputs) : inputs[0];
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

const sumUsage = (us: ModelUsage[]): ModelUsage => ({
  model: us[0].model,
  tokensIn: us.reduce((s, u) => s + u.tokensIn, 0),
  tokensOut: us.reduce((s, u) => s + u.tokensOut, 0),
  usdCeiling: us.reduce((s, u) => s + u.usdCeiling, 0),
  usdActual: us.some((u) => u.usdActual === null) ? null : us.reduce((s, u) => s + (u.usdActual ?? 0), 0),
});

export const IMAGE_FORMAT = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;


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


export class BedrockNovaClassifier implements LineClassifier {
  private readonly o: Required<Options>;
  constructor(opts: Options) {
    this.o = { modelId: NOVA_MODELS.pro, maxTokens: 4096, ...opts };
  }

  async classify(input: { receipt: ParsedReceipt; needs: Need[]; rules: string }) {
    const first = await this.ask(input, input.receipt.lines);
    const answered = new Set(first.lines.map((l) => l.lineNo));
    const missing = input.receipt.lines.filter((l) => !answered.has(l.lineNo));
    if (missing.length === 0) return first;
    // An unanswered line is never funded, so it is worth one more question, about those lines alone.
    try {
      const again = await this.ask(input, missing);
      const wanted = new Set(missing.map((l) => l.lineNo));
      return { lines: [...first.lines, ...again.lines.filter((l) => wanted.has(l.lineNo))].sort((a, b) => a.lineNo - b.lineNo), usage: sumUsage([first.usage, again.usage]) };
    } catch (e) {
      if (e instanceof ModelOutputError) return first;
      throw e;
    }
  }

  private async ask(input: { receipt: ParsedReceipt; needs: Need[]; rules: string }, asked: ParsedReceipt["lines"]) {
    const needs = input.needs.map((n) => ({ id: n.id, label: n.label, unit: n.unit, qtyNeeded: n.qtyNeeded }));
    const lines = asked.map((l) => ({ lineNo: l.lineNo, rawText: l.rawText, translationEn: l.translationEn, qty: l.qty, amountMinor: l.amountMinor }));
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
      merge: (inputs) => ({ lines: inputs.map((i) => (i as { lines?: unknown }).lines).join("\n") }),
      convert: classificationsFromWire,
      schema: z.array(LineClassification),
    });
    return { lines: value, usage };
  }
}
