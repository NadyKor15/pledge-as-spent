// Deterministic clean-up of a structured reading: rows a model turned into "lines" that are not products,
// and discount signs that OCR dropped.

/**
 * Words that mark a row as part of the receipt's totals, tax, payment or footer in Japanese, Turkish, Spanish and
 * English, never as a product. Japanese terms match anywhere; Latin terms only as whole words, so a product such as
 * "ACEITE OLIVA" is not mistaken for "IVA".
 */
const CJK_TERMS = ["小計", "合計", "消費税", "内税", "外税", "対象", "税込", "税率", "お預り", "お預かり", "お釣り", "お支払", "クレジット", "現金", "ポイント", "会員", "レジ", "担当", "レシート", "ご来店", "ありがとう", "※は", "軽減"];
const LATIN_TERMS = [
  "subtotal", "sub total", "total", "toplam", "importe", "base imponible", "base",
  "sales tax", "tax", "vat", "kdv", "topkdv", "matrah", "iva", "cuota",
  "cash", "change", "visa", "mastercard", "credit card", "debit card", "approved", "nakit", "para üstü", "kredi kartı", "pago tarjeta", "pago efectivo", "efectivo", "cambio", "entregado",
  "rewards member", "member", "socio", "müşteri kartı", "reg", "trans", "thank you", "come again", "gracias por su visita", "teşekkür ederiz", "factura simplificada", "fiş no", "tarih", "descripción", "caja",
];
const latin = new RegExp(`(?<![\\p{L}\\p{N}])(?:${LATIN_TERMS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "u");

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/**
 * A row that only gives a quantity and a unit price ("4点 x 単118", "2 x 24,50", "6 @ $1.49"), also when OCR turned
 * the character after the quantity into noise ("4m x 単 458").
 */
const QTY_ROW = /^\s*(\d+)\s*\S{0,3}\s*[x×@]\s*\D{0,2}\s*([\d.,]+)\s*$/i;

export const isQtyRow = (text: string) => QTY_ROW.test(text.normalize("NFKC"));

/** The quantity and the unit price as printed on such a row. */
export function qtyRow(text: string): { qty: number; unit: string } | null {
  const m = text.normalize("NFKC").match(QTY_ROW);
  return m ? { qty: Number(m[1]), unit: m[2] } : null;
}

export function isNonProductRow(text: string): boolean {
  const t = norm(text).trim();
  if (t === "") return true;
  if (isQtyRow(t)) return true;
  // Only digits, symbols and punctuation: a number or a rule line, not a product name.
  if (!/\p{L}/u.test(t.replace(/[x×]/g, ""))) return true;
  return CJK_TERMS.some((w) => t.includes(w)) || latin.test(t);
}

const DISCOUNT = /値引|割引|coupon|discount|dto\b|dto\.|descuento|promoci|indirim|iskonto|desc\./i;

/**
 * Drops lines that are not products, makes a line whose text names a discount negative (OCR often loses the
 * minus sign), and renumbers. Returns the input unchanged when every row would be dropped.
 */
export function cleanLines<T extends { rawText: string; amountMinor: unknown; lineNo?: unknown }>(lines: T[]): T[] {
  // A negative row is a discount even without a word for it, but "TOPKDV" with a sign a model gave it is not.
  const kept = lines.filter((l) => !isNonProductRow(l.rawText) || (typeof l.amountMinor === "number" && l.amountMinor < 0 && DISCOUNT.test(norm(l.rawText))));
  if (kept.length === 0) return lines;
  return kept.map((l, i) => ({
    ...l,
    lineNo: i + 1,
    amountMinor: typeof l.amountMinor === "number" && l.amountMinor > 0 && DISCOUNT.test(norm(l.rawText)) ? -l.amountMinor : l.amountMinor,
  }));
}
