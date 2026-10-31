// Personal data found by where it stands on a receipt, not by what a model thought of the text: OCR turns a masked
// card number into noise and a katakana name into Latin letters, but the rows around them do not change. Everything
// here works on rows below the total; what a row holds decides the box, and the blur follows the box.

import type { Box } from "./prep";
import type { OcrLine, OcrWord } from "./ocr";
import { isNonProductRow } from "./clean";
import type { PiiRegion } from "./types";
import type { z } from "zod";

export type FoundPii = z.infer<typeof PiiRegion>;

export const TOTAL_ROW = /合計|(?<![\p{L}])total(?![\p{L}])|toplam|importe/iu;
const SUBTOTAL_ROW = /小計|sub\s*total|ara\s*toplam/i;
const MEMBER_LABEL = /会員|member|socio|m[üu][şs]ter[iİ]/i;
/** A payment label on the card's row: a card brand, or katakana (OCR splits クレジット into pieces). */
const PAY_WORD = /^(?:visa|mastercard|master|amex|tarjeta|[\p{Script=Katakana}ー]+)$/iu;
const MONEY = /[¥￥$€₺]|\d[.,]\d{2}\b|\d,\d{3}/;

const span = (words: OcrWord[]): Box => {
  const x0 = Math.min(...words.map((w) => w.box.x));
  const y0 = Math.min(...words.map((w) => w.box.y));
  const x1 = Math.max(...words.map((w) => w.box.x + w.box.w));
  const y1 = Math.max(...words.map((w) => w.box.y + w.box.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Index of the row with the receipt's total: the last such row, because a payment block may repeat the word. */
export function totalRow(lines: { text: string }[]): number {
  let at = -1;
  lines.forEach((l, i) => {
    if (TOTAL_ROW.test(l.text) && !SUBTOTAL_ROW.test(l.text)) at = i;
  });
  return at;
}

export function anchorPii(lines: OcrLine[]): FoundPii[] {
  const start = totalRow(lines);
  if (start < 0) return [];
  const found: FoundPii[] = [];
  const member = new Set<number>();
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const digitWords = l.words.filter((w) => /\d{3,}/.test(w.text));
    if (MEMBER_LABEL.test(l.text) && digitWords.length > 0) {
      member.add(i);
      const from = l.words.findIndex((w) => /\d{3,}/.test(w.text));
      const words = l.words.slice(from);
      found.push({ kind: "member_id", text: words.map((w) => w.text).join(" "), bbox: span(words) });
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (member.has(i)) continue;
    const l = lines[i];
    // A masked card number: noise or stars ending in the last digits, with no amount on the row.
    if (/\d{3,}\D*$/.test(l.text) && !MONEY.test(l.text) && !/\b(?:tel|no|fi[şs])\b/i.test(l.text)) {
      const words = l.words.filter((w) => !PAY_WORD.test(w.text));
      if (words.length) found.push({ kind: "card_number", text: words.map((w) => w.text).join(" "), bbox: span(words) });
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (member.has(i)) continue;
    const honorific = /様\s*$/.test(l.text);
    const nextToMember = member.has(i - 1) || member.has(i + 1);
    if (!honorific && !nextToMember) continue;
    if (/\d{3,}/.test(l.text) || isNonProductRow(l.text)) continue;
    const words = l.words.filter((w) => !/^様$/.test(w.text.trim()));
    if (words.length) found.push({ kind: "name", text: words.map((w) => w.text).join(" ").replace(/\s*様\s*$/, ""), bbox: span(words) });
  }
  return found;
}
