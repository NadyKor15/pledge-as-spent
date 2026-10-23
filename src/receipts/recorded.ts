import { createHash } from "node:crypto";
import { z } from "zod";
import type { CurrencyCode } from "../core/types";
import { sha256Hex } from "./hash";
import { LineClassification, ParsedReceipt, type LineClassifier, type ModelUsage, type ReceiptImage, type ReceiptReader } from "./types";

// Replays stored model answers, so tests and cached demo receipts need no model.

export const Recordings = z.object({
  /** ParsedReceipt by sha256 of the image bytes. */
  readings: z.record(z.string(), ParsedReceipt),
  /** Line classifications by receiptKey of the parsed receipt they were made for. */
  classifications: z.record(z.string(), z.array(LineClassification)),
});
export type Recordings = z.infer<typeof Recordings>;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Identity of a parsed receipt: the key under which its classifications are recorded. */
export function receiptKey(r: ParsedReceipt): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

const NO_COST = (model: string): ModelUsage => ({ model, tokensIn: 0, tokensOut: 0, usdCeiling: 0, usdActual: 0 });

export class RecordedReader implements ReceiptReader {
  constructor(private readonly rec: Pick<Recordings, "readings">) {}

  async read(image: ReceiptImage, _hint: { currency: CurrencyCode; languages: string[] }) {
    const key = sha256Hex(image.bytes);
    const receipt = this.rec.readings[key];
    if (!receipt) throw new Error(`no recorded reading for image sha256 ${key}`);
    return { receipt: structuredClone(receipt), usage: NO_COST("recorded") };
  }
}

export class RecordedClassifier implements LineClassifier {
  constructor(private readonly rec: Pick<Recordings, "classifications">) {}

  async classify(input: Parameters<LineClassifier["classify"]>[0]) {
    const key = receiptKey(input.receipt);
    const lines = this.rec.classifications[key];
    if (!lines) throw new Error(`no recorded classification for receipt key ${key}`);
    return { lines: structuredClone(lines), usage: NO_COST("recorded") };
  }
}
