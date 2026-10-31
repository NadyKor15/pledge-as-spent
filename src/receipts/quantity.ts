// Deterministic second opinion on what a classifier said about a receipt line: how many need-units the line
// is worth (from the printed quantity and the pack size in the name) and whether the product is on the forbidden
// list. The classifier's own quantity is used only when the row does not say.

import type { Need } from "../core/types";
import type { LineClassification, LineClassifier, ParsedReceipt } from "./types";

// "İ" lower-cases to "i" plus a combining dot; drop the dot so Turkish words match their plain spelling.
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/i\u0307/g, "i").replace(/ı/g, "i");

/**
 * Items in a pack, from its name: 20本入, 6本ケース, 3缶パック (Japanese); 4'LÜ, 10'LU, 12'Lİ (Turkish);
 * 8U, PACK 6 (Spanish); 24PK, 4CT, 6 pcs (English). Sheets (枚, "44 count" of diapers) are not packs of products:
 * the need's own unit decides whether a pack size counts. Null when the name gives none.
 */
export function packCount(text: string): number | null {
  const t = norm(text);
  const patterns = [
    /(\d{1,3})\s*(?:本|缶|個|袋|箱|ロール)\s*(?:入り?|パック|ケース|セット)?/,
    /(\d{1,3})\s*['’´]\s*l[üuıi](?![\p{L}\p{N}])/u,
    /(?<![\p{L}\p{N}])(\d{1,3})\s*(?:pk|ct|pcs|pc|pack|count|u)(?![\p{L}\p{N}])/u,
    /(?<![\p{L}\p{N}])(?:pack|pk)\s*(\d{1,3})(?![\p{L}\p{N}])/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * How many of the need's unit one receipt line is worth, or null when the row does not say. A need counted in
 * packs (diapers) takes the printed quantity: the number of sheets in a pack is not the count. Any other unit
 * (piece, bottle, can) takes the printed quantity times the pack size in the name, so "20本入" bought once is 20.
 */
export function deriveNeedQty(line: ParsedReceipt["lines"][number], need: Pick<Need, "unit">): number | null {
  const printed = typeof line.qty === "number" && Number.isInteger(line.qty) && line.qty > 0 ? line.qty : null;
  if (/\bpack\b/i.test(need.unit)) return printed ?? 1;
  const pack = packCount(line.rawText);
  if (printed === null && pack === null) return null;
  return (printed ?? 1) * (pack ?? 1);
}

const FORBIDDEN: Record<"alcohol" | "tobacco" | "gift_card", { cjk: string[]; latin: string[] }> = {
  alcohol: {
    cjk: ["ビール", "ワイン", "日本酒", "焼酎", "ウイスキー", "ウィスキー", "チューハイ", "酒", "ハイボール"],
    latin: ["beer", "lager", "ale", "wine", "vodka", "whisky", "whiskey", "rum", "gin", "brandy", "liquor", "spirits", "sake", "champagne", "cider", "bira", "şarap", "rakı", "raki", "votka", "viski", "cerveza", "vino", "licor", "cava", "ron", "ginebra", "alcohol", "alkol"],
  },
  tobacco: {
    cjk: ["たばこ", "タバコ", "煙草", "葉巻"],
    latin: ["cigarette", "cigarettes", "cigar", "cigars", "tobacco", "sigara", "tütün", "tabaco", "cigarrillos", "cajetilla", "snuff", "vape"],
  },
  gift_card: {
    cjk: ["ギフトカード", "ギフト券", "商品券", "プリペイド", "図書カード"],
    latin: ["gift card", "giftcard", "gift voucher", "voucher", "gift certificate", "prepaid card", "tarjeta regalo", "cheque regalo", "tarjeta de regalo", "hediye kartı", "hediye çeki", "hediye kart"],
  },
};
/** OCR takes the dakuten of ビ for a handakuten or doubles the kana: 缶ピール, 缶ビピール. Only where a drink's size or can stands next to it, so ピール (peel) and ヒール (heel) pass. */
const BEER_MISREAD = /[ヒビピ]{1,2}ー[ルレ].*(?:\d\s*m[l1t]|缶)|缶.*[ヒビピ]{1,2}ー[ルレ]/;
const NON_ALCOHOLIC = /ノンアルコール|non[- ]?alcoholic|alcohol[- ]free|sin alcohol|alkolsüz|0[.,]0\s*%|shirley|root beer|ginger (?:beer|ale)|gingerale/i;
const toRe = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(norm).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "u");
const LATIN_RE = Object.fromEntries(Object.entries(FORBIDDEN).map(([k, v]) => [k, toRe(v.latin)])) as Record<keyof typeof FORBIDDEN, RegExp>;

/** The forbidden category a product name belongs to, if any; non-alcoholic drinks are not alcohol. */
export function forbiddenCategory(text: string): "alcohol" | "tobacco" | "gift_card" | null {
  const t = norm(text);
  for (const k of ["gift_card", "tobacco", "alcohol"] as const) {
    if (k === "alcohol" && NON_ALCOHOLIC.test(t)) continue;
    if (FORBIDDEN[k].cjk.some((w) => t.includes(w)) || LATIN_RE[k].test(t)) return k;
    if (k === "alcohol" && BEER_MISREAD.test(t)) return k;
  }
  return null;
}

const GENERIC_REASON = {
  alcohol: "Alcohol is not funded.",
  tobacco: "Tobacco is not funded.",
  gift_card: "Gift cards are not funded.",
} as const;

/**
 * Applies the deterministic checks to a classifier's answer: a line whose name is alcohol, tobacco or a gift card
 * is rejected with that rule code whatever the classifier said; for an eligible line the quantity comes from
 * the printed row when it says (the classifier's own number is the fallback).
 */
export function refineClassifications(receipt: ParsedReceipt, needs: Need[], labels: LineClassification[]): LineClassification[] {
  const lineByNo = new Map(receipt.lines.map((l) => [l.lineNo, l]));
  return labels.map((c) => {
    const line = lineByNo.get(c.lineNo);
    if (!line || line.amountMinor < 0) return c; // a discount follows the line above it
    const hint = forbiddenCategory(`${line.rawText} ${line.translationEn}`);
    if (hint && c.ruleCode !== hint) {
      return { ...c, verdict: "rejected", needId: null, needQty: null, ruleCode: hint, reasonEn: GENERIC_REASON[hint], confidence: Math.max(c.confidence, 0.9) };
    }
    if (c.verdict === "eligible" && c.needId) {
      const need = needs.find((n) => n.id === c.needId);
      const derived = need ? deriveNeedQty(line, need) : null;
      if (derived !== null) return { ...c, needQty: derived };
    }
    return c;
  });
}

/** A classifier whose answers go through `refineClassifications`. */
export class RefiningClassifier implements LineClassifier {
  constructor(private readonly inner: LineClassifier) {}
  async classify(input: Parameters<LineClassifier["classify"]>[0]) {
    const out = await this.inner.classify(input);
    return { ...out, lines: refineClassifications(input.receipt, input.needs, out.lines) };
  }
}
