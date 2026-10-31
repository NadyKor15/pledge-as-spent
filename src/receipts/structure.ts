// Second step of the multi-step readers: text in, receipt rows out. No image, so it is cheap and cannot
// be fooled by the picture; it can only be as good as the text it is given.

import { z } from "zod";
import type { CurrencyCode } from "../core/types";
import { converse, fails, ModelOutputError, READER_SYSTEM, receiptFromText, type Options } from "./bedrock";
import { ParsedReceipt, type ModelUsage } from "./types";

// The output form and rules are the single-step reader's; only the introduction changes.
// Receipts print the quantity and unit price on a row below the product ("4点 x 単118", "2 x 24,50", "6 @ $1.49").
const ROW_RULES = " A row that only gives a quantity and a unit price belongs to the product row above it: it supplies qty and unit; amount is the line total printed on the product's own row, and you never multiply or add anything yourself. Rows that continue a product name (a size, a pack count) join that product's text.";

const FORM = READER_SYSTEM.slice(READER_SYSTEM.indexOf("\nAnswer in plain text"));

export const TRANSCRIPTION_STRUCTURE_SYSTEM = `You are given a verbatim transcription of a store receipt (one printed row per line, in the original script) for a disaster-relief fundraiser. Turn it into structured rows. Every value must come from the transcription; never invent one.${ROW_RULES}${FORM}`;

export const OCR_STRUCTURE_SYSTEM = `You are given the text that OCR software read from a photo of a store receipt (one printed row per line, in the original script) for a disaster-relief fundraiser. Letters may be misread (half-width katakana most of all), stray symbols may appear, and the digits may be slightly off. Turn it into structured rows. Every value must come from the text; never invent one, and never calculate a new amount: keep the digits as read. A backslash, Y or ¥ in front of an amount is the currency sign, not a digit.${ROW_RULES} merchant is the store name together with the branch row printed under it. In en write the short English name of the product as well as you can make it out, even from garbled text; 単3 is AA and 単4 is AAA. A date must be a real date. Ignore stray symbols and fragments that are not receipt rows.${FORM}`;

export const sumUsage = (us: ModelUsage[]): ModelUsage => ({
  model: us[0]?.model ?? "",
  tokensIn: us.reduce((s, u) => s + u.tokensIn, 0),
  tokensOut: us.reduce((s, u) => s + u.tokensOut, 0),
  usdCeiling: us.reduce((s, u) => s + u.usdCeiling, 0),
  usdActual: us.some((u) => u.usdActual === null) ? null : us.reduce((s, u) => s + (u.usdActual ?? 0), 0),
});

/** Structures a transcription or OCR text into a receipt-shaped object (validated later, once personal data is attached). */
export async function structureText(
  o: Required<Options>,
  args: { what: string; source: "transcription" | "ocr"; text: string; hint: { currency: CurrencyCode; languages: string[] } },
): Promise<{ obj: Record<string, unknown>; usage: ModelUsage; answer: string }> {
  const { out, usage } = await converse(o, {
    what: args.what,
    system: args.source === "ocr" ? OCR_STRUCTURE_SYSTEM : TRANSCRIPTION_STRUCTURE_SYSTEM,
    content: [{ text: `Expected currency: ${args.hint.currency} (report the currency actually printed). Likely languages: ${args.hint.languages.join(", ")}.\n\n${args.source === "ocr" ? "OCR text" : "Transcription"}:\n${args.text}` }],
  });
  const answer = (out.output?.message?.content ?? []).map((b) => b.text ?? "").join("\n");
  const fail = fails(args.what, out.stopReason, usage, answer);
  if (out.stopReason === "max_tokens") throw fail("the answer was cut off");
  try {
    return { obj: receiptFromText(answer) as Record<string, unknown>, usage, answer };
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
}

/** Validates with the unchanged schema; failures carry the cost of every call made so far. */
export function validateReceipt(obj: unknown, what: string, usage: ModelUsage, raw: unknown) {
  const parsed = ParsedReceipt.safeParse(obj);
  if (!parsed.success) throw Object.assign(new ModelOutputError(`${what}: output does not match the schema: ${z.prettifyError(parsed.error)}`), { usage, raw });
  return parsed.data;
}
