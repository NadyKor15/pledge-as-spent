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
 * blurred copy, which keeps the photo's size). Kept beside the reading, not in it: a model never writes these.
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

export interface ReceiptReader {
  /** `lineBoxes`: readers that see where rows are printed (OCR) say so; the others leave it out. */
  read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }): Promise<{ receipt: ParsedReceipt; usage: ModelUsage; lineBoxes?: LineBox[] }>;
}

export interface LineClassifier {
  classify(input: {
    receipt: ParsedReceipt;
    needs: Need[];
    rules: string;
  }): Promise<{ lines: LineClassification[]; usage: ModelUsage }>;
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
