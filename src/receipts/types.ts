import { z } from "zod";
import type { CurrencyCode, Need } from "../core/types";

// What a model may say about a receipt photo. Models read and classify; code
// reconciles totals, checks duplicates, dates and zone, and decides money.

export const PiiRegion = z.object({
  kind: z.enum(["card_number", "name", "phone", "address", "member_id", "other"]),
  text: z.string(),
  /** Normalised 0..1 box on the image, when the reader can locate it. */
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
});

export const ReceiptLine = z.object({
  lineNo: z.number().int().positive(),
  rawText: z.string(),
  translationEn: z.string(),
  qty: z.number().positive().nullable(),
  unitPriceMinor: z.number().int().nullable(),
  /** Signed: discounts are negative and belong to the line above them. */
  amountMinor: z.number().int(),
  /** Tax rate in basis points when printed per line (Japan: 800 or 1000). */
  taxRateBp: z.number().int().nullable(),
});

export const ParsedReceipt = z.object({
  merchantName: z.string(),
  merchantAddress: z.string().nullable(),
  country: z.string().nullable(),
  currency: z.string(),
  /** Local date-time printed on the receipt, ISO without zone, or null. */
  purchasedAt: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  lines: z.array(ReceiptLine),
  subtotalMinor: z.number().int().nullable(),
  taxMinor: z.number().int().nullable(),
  /** true: prices include tax; false: tax is added at the end; null: not printed. */
  taxIncluded: z.boolean().nullable(),
  totalMinor: z.number().int(),
  pii: z.array(PiiRegion),
  readability: z.enum(["good", "poor", "unreadable"]),
});
export type ParsedReceipt = z.infer<typeof ParsedReceipt>;

export const LineClassification = z.object({
  lineNo: z.number().int().positive(),
  needId: z.string().nullable(),
  /** Quantity in the need's unit (6 bottles, 2 packs), or null. */
  needQty: z.number().nonnegative().nullable(),
  verdict: z.enum(["eligible", "rejected", "review"]),
  ruleCode: z.enum(["alcohol", "tobacco", "gift_card", "not_in_needs", "other_rule", "unclear"]).nullable(),
  /** One plain sentence a donor can read. */
  reasonEn: z.string(),
  confidence: z.number().min(0).max(1),
});
export type LineClassification = z.infer<typeof LineClassification>;

/**
 * Where one parsed line is printed: the box of its OCR row, in fractions 0..1 of the photo (and of its published,
 * closed copy, which keeps the photo's size). Kept beside the reading, not in it: a model never writes these.
 */
export const LineBox = z.object({
  lineNo: z.number().int().positive(),
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) }),
});
export type LineBox = z.infer<typeof LineBox>;

export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Worst-case price charged to the spend cap before the call. */
  usdCeiling: number;
  /** Price from the real token counts, when the provider reports them. */
  usdActual: number | null;
}

export interface ReceiptImage {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

/** One printed row found by pixels (src/receipts/slice.ts): y in the straightened paper, `quad` on the original photo. */
export const Band = z.object({ index: z.number().int().positive(), y0: z.number(), y1: z.number(), quad: z.array(z.tuple([z.number(), z.number()])).length(4) });
export type Band = z.infer<typeof Band>;

/**
 * The second, independent reading: the same model on the numbered cuts of the printed rows. `lineBands[i]` are the
 * cut numbers its i-th line says it is printed on; `bandTexts` what it read on each cut. Null receipt: it failed.
 */
export const SecondReading = z.object({
  receipt: ParsedReceipt.nullable(),
  lineBands: z.array(z.array(z.number().int().positive())),
  bandTexts: z.record(z.string(), z.string()),
  bands: z.array(Band),
  /** The original photo's size in pixels: the quads of `bands` are in it. */
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
  error: z.string().nullable(),
});
export type SecondReading = z.infer<typeof SecondReading>;

/** A purchase line and the printed rows it stands on: the only rows a closed copy of the photo may show. */
export interface PurchaseLine {
  lineNo: number;
  bandIndexes: number[];
}

export interface ReceiptReader {
  /**
   * `lineBoxes`: readers that see where rows are printed (OCR, pixel bands) say so; the others leave it out.
   * `second`: readers that read twice return the second reading for the classifier to check the first against.
   */
  read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }): Promise<{ receipt: ParsedReceipt; usage: ModelUsage; lineBoxes?: LineBox[]; second?: SecondReading }>;
}

export interface LineClassifier {
  classify(input: {
    receipt: ParsedReceipt;
    needs: Need[];
    rules: string;
    second?: SecondReading;
    /** The photo, for a reader that looks again at a disputed line. */
    image?: ReceiptImage;
  }): Promise<{ lines: LineClassification[]; usage: ModelUsage; agreement?: Agreement }>;
}

/** What comparing two readings found: the purchase lines with their rows, their boxes, and why lines were held. */
export interface Agreement {
  purchaseLines: PurchaseLine[];
  lineBoxes: LineBox[];
  /** The classifier's own answers for both readings, before the comparison: kept so the rule can be re-run offline. */
  raw: { first: LineClassification[]; second: LineClassification[]; third?: Record<string, ParsedReceipt["lines"][number] | null> };
  held: { lineNo: number; why: string }[];
}

/** An approved receipt line turned into money for one need. */
export type FundableLine = {
  receiptId: string;
  lineNo: number;
  needId: string;
  /** Quantity credited to the need, in the need's unit. */
  needQty: number;
  /** Line amount in the drive's base currency minor units, with its share of added-on tax. */
  amountBase: number;
};

/** Quantity already credited per need id by earlier approved receipts. */
export type NeedProgress = Record<string, number>;
