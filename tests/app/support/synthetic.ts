import { PNG } from "pngjs";
import { receiptKey, type Recordings } from "../../../src/receipts/recorded";
import { sha256Hex } from "../../../src/receipts/hash";
import type { LineClassification, ParsedReceipt } from "../../../src/receipts/types";

// Synthetic receipts for scenarios the eval set does not have: a small noise
// PNG (distinct bytes and dHash per seed) with a reading and classification
// registered in the recordings, so the Recorded reader serves them.

export function noisePng(seed: number, width = 64, height = 96): Uint8Array {
  const png = new PNG({ width, height });
  let x = seed * 2654435761;
  for (let i = 0; i < png.data.length; i += 4) {
    x = (x * 1103515245 + 12345) >>> 0;
    const v = x >>> 24;
    png.data[i] = v;
    png.data[i + 1] = v;
    png.data[i + 2] = v;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

export interface SyntheticLine {
  needId: string | null;
  qty: number;
  amount: number;
  verdict?: LineClassification["verdict"];
  ruleCode?: LineClassification["ruleCode"];
  confidence?: number;
}

export function syntheticReceipt(
  rec: Recordings,
  seed: number,
  lines: SyntheticLine[],
  over: Partial<ParsedReceipt> = {},
): { bytes: Uint8Array; parsed: ParsedReceipt } {
  const bytes = noisePng(seed);
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const parsed: ParsedReceipt = {
    merchantName: `Kitasora Mart ${seed}`,
    merchantAddress: "空川県北空市本町1-1",
    country: "JP",
    currency: "JPY",
    purchasedAt: `2026-11-06T10:${String(seed % 60).padStart(2, "0")}:00`,
    receiptNumber: String(seed),
    lines: lines.map((l, i) => ({ lineNo: i + 1, rawText: `item ${i + 1}`, translationEn: `item ${i + 1}`, qty: l.qty, unitPriceMinor: null, amountMinor: l.amount, taxRateBp: 800 })),
    subtotalMinor: total,
    taxMinor: null,
    taxIncluded: true,
    totalMinor: total,
    pii: [],
    readability: "good",
    ...over,
  };
  rec.readings[sha256Hex(bytes)] = parsed;
  rec.classifications[receiptKey(parsed)] = lines.map((l, i) => ({
    lineNo: i + 1,
    // A refused line names no need; a "review" line may carry the classifier's guess.
    needId: l.verdict === "rejected" ? null : l.needId,
    needQty: l.verdict === "rejected" ? null : l.qty,
    verdict: l.verdict ?? "eligible",
    ruleCode: l.ruleCode ?? null,
    reasonEn: "synthetic",
    confidence: l.confidence ?? 1,
  }));
  return { bytes, parsed };
}
