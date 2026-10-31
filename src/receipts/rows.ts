// Deterministic repairs of the OCR rows. Tesseract and Nova fail in opposite ways: Tesseract keeps Japanese words
// but misreads digits (a dotted zero comes out as 9, 6 or @) and half-width katakana; Nova invents Japanese words
// but copies digits faithfully. So words stay Tesseract's, digits are checked against Nova's copy of the numbers,
// and rows the engine doubts are read again, stretched to full-width proportions.

import { PNG } from "pngjs";
import { isNonProductRow } from "./clean";
import type { OcrEngine, OcrLine } from "./ocr";
import { totalRow } from "./pii";
import type { Box, Rgba } from "./prep";

/** Rows the engine is less sure of than this are read again. */
export const REREAD_BELOW_CONFIDENCE = 80;
/** How much better the second reading must be to replace the first. */
const REREAD_MARGIN = 5;
/** Half-width kana are half as wide as the glyphs the Japanese model knows: 1.5 was the best of 1, 1.5, 2 and 2.5 on the benchmark's rows. */
const STRETCH_X = 2;
const STRETCH_Y = 4 / 3;

/** A word that is an amount, with its currency sign and at most one mark after it. */
const AMOUNT_WORD = /^[¥￥$€₺£*\\Y#]-?\d[\d.,]*\S?$/;
/** A pack size or volume at the end of a name ("2L"): the stretched reading loses it, the first one had it. */
const SIZE_WORD = /^\d+(?:[.,]\d+)?(?:l|ml|g|kg)$/i;

/** The part of a row that names the product: everything left of the amount printed at its end. */
function nameBox(line: OcrLine): { box: Box; amount: string } | null {
  const last = line.words.at(-1);
  if (!last || line.words.length < 2 || !AMOUNT_WORD.test(last.text)) return null;
  const name = line.words[line.words.length - 2];
  return { box: { x: line.box.x, y: line.box.y, w: Math.max(0.01, name.box.x + name.box.w - line.box.x), h: line.box.h }, amount: last.text };
}

/** A row cut out of the prepared image, grey, stretched by the factors above, with a little room above and below. */
export function stretchedRow(img: Rgba, box: Box): Uint8Array {
  const x0 = Math.max(0, Math.floor((box.x - 0.01) * img.width));
  const x1 = Math.min(img.width - 2, Math.ceil((box.x + box.w + 0.01) * img.width));
  const y0 = Math.max(0, Math.floor((box.y - box.h * 0.3) * img.height));
  const y1 = Math.min(img.height - 2, Math.ceil((box.y + box.h * 1.3) * img.height));
  const w = Math.max(1, Math.round((x1 - x0) * STRETCH_X));
  const h = Math.max(1, Math.round((y1 - y0) * STRETCH_Y));
  const png = new PNG({ width: w, height: h });
  const grey = (i: number) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  for (let y = 0; y < h; y++) {
    const sy = y0 + y / STRETCH_Y;
    const yi = Math.floor(sy);
    const fy = sy - yi;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x / STRETCH_X;
      const xi = Math.floor(sx);
      const fx = sx - xi;
      const i = (yi * img.width + xi) * 4;
      const j = i + img.width * 4;
      const v = grey(i) * (1 - fx) * (1 - fy) + grey(i + 4) * fx * (1 - fy) + grey(j) * (1 - fx) * fy + grey(j + 4) * fx * fy;
      const o = (y * w + x) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/**
 * A half-width dakuten comes back as a straight quote after its kana (へ" for ﾍﾞ), and with the kana lost at the start
 * of a row as a bare quote. Puts the mark back on the kana, as katakana, and drops a bare one.
 */
export function halfWidthMarks(text: string): string {
  return text
    .replace(/^[\s"'^]+/, "")
    .replace(/([\u3041-\u3096\u30a1-\u30fa])["'゛]/gu, (_, kana: string) => {
      const kata = kana.replace(/[\u3041-\u3096]/, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
      return `${kata}\u3099`.normalize("NFC");
    })
    // A size letter comes back with a stray N in front of it.
    .replace(/\s*N([SML])$/, " $1")
    .replace(/\s+/g, " ")
    .trim();
}

const katakanaShare = (text: string) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length ? letters.filter((c) => /[\p{Script=Katakana}ー]/u.test(c)).length / letters.length : 0;
};

/**
 * Japanese receipts only: product rows and the customer's name are read again when the engine doubts them, stretched.
 * A half-width name comes back readable (ﾐﾈﾗﾙｳｫｰﾀｰ from "ミ 1 胞オケー" to "ミネラルウォーター") and a row of ordinary
 * glyphs gets worse, so a clearly higher confidence decides, or, for a row the engine was unsure of anyway, an answer
 * that is plainly katakana at about the same confidence. The amount at the end of the row is kept as it was.
 */
export async function rereadDoubtfulRows(img: Rgba, lines: OcrLine[], engine: OcrEngine, languages: string[]): Promise<OcrLine[]> {
  if (!engine.recognizeRow || !languages.includes("ja")) return lines;
  const total = totalRow(lines);
  const out: OcrLine[] = [];
  for (const [i, line] of lines.entries()) {
    const conf = line.confidence ?? 100;
    const named = nameBox(line);
    const belowTotal = total >= 0 && i > total && !/\d/.test(line.text);
    if (conf >= REREAD_BELOW_CONFIDENCE || !(named || belowTotal) || isNonProductRow(line.text)) {
      out.push(line);
      continue;
    }
    const again = await engine.recognizeRow(stretchedRow(img, named?.box ?? line.box), languages);
    const text = halfWidthMarks(again.text);
    const better = again.confidence >= conf + REREAD_MARGIN || (conf < 75 && again.confidence >= conf - 5 && katakanaShare(text) >= 0.6);
    if (text === "" || !better) {
      out.push(line);
      continue;
    }
    const size = line.words.map((w) => w.text).find((w) => SIZE_WORD.test(w) && !text.includes(w));
    out.push({ ...line, text: [text, size, named?.amount].filter(Boolean).join(" "), confidence: again.confidence, reread: true });
  }
  return out;
}

// ------------------------------------------------------------------ digits

interface Token {
  /** The number as printed. */
  text: string;
  digits: string;
  row: number;
  index: number;
}

function tokens(rows: string[]): Token[] {
  const out: Token[] = [];
  rows.forEach((text, row) => {
    for (const m of text.matchAll(/\d(?:[\d.,]*\d)?/g)) out.push({ text: m[0], digits: m[0].replace(/\D/g, ""), row, index: m.index });
  });
  return out;
}

/**
 * True when `seen` can be what OCR made of `real`. Only a zero is taken for something else (the receipts' zero has
 * a dot in it), or dropped, or a character after the number comes out as one digit more ("10点" as "104").
 * Anything else is a real difference, and the photo's copy is not trusted over the OCR: Nova misreads digits too.
 */
export function zeroMisread(seen: string, real: string): boolean {
  if (seen === real) return false;
  // A minus or percent sign in front of the number comes out as 4 or 5 ("-0,06" as "40,06", "%20" as "420").
  if (seen.length === real.length + 1 && "45".includes(seen[0]) && seen.slice(1) === real) return true;
  if (seen.length === real.length) {
    return [...seen].every((c, i) => c === real[i] || (real[i] === "0" && "1689".includes(c)));
  }
  if (real.length === seen.length + 1) return real.endsWith("0") && real.slice(0, -1) === seen;
  return seen.length === real.length + 1 && seen.startsWith(real);
}

/**
 * Aligns all numbers of the OCR rows with all numbers Nova copied from the photo (the two rarely agree on rows, so
 * the alignment runs over the numbers) and corrects the OCR's zeros. Returns the rows and what was changed.
 */
export function repairDigits(lines: OcrLine[], photoRows: string[]): { lines: OcrLine[]; repairs: { from: string; to: string }[] } {
  const a = tokens(lines.map((l) => l.text));
  const b = tokens(photoRows);
  const score = (x: Token, y: Token) => (x.digits === y.digits ? 3 : zeroMisread(x.digits, y.digits) ? 2 : -2);
  const GAP = -1;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, (_, i) => Float64Array.from({ length: m + 1 }, (_, j) => (i + j) * GAP));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) dp[i][j] = Math.max(dp[i - 1][j - 1] + score(a[i - 1], b[j - 1]), dp[i - 1][j] + GAP, dp[i][j - 1] + GAP);
  const fixes = new Map<number, Map<number, { from: string; to: string }>>();
  const repairs: { from: string; to: string }[] = [];
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (dp[i][j] === dp[i - 1][j - 1] + score(a[i - 1], b[j - 1])) {
      const x = a[i - 1];
      const y = b[j - 1];
      if (zeroMisread(x.digits, y.digits)) {
        const row = fixes.get(x.row) ?? new Map<number, { from: string; to: string }>();
        row.set(x.index, { from: x.text, to: y.text });
        fixes.set(x.row, row);
        repairs.unshift({ from: x.text, to: y.text });
      }
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + GAP) i--;
    else j--;
  }
  const out = lines.map((l, r) => {
    const row = fixes.get(r);
    if (!row) return l;
    let text = l.text;
    for (const [index, f] of [...row].sort((p, q) => q[0] - p[0])) text = text.slice(0, index) + f.to + text.slice(index + f.from.length);
    return { ...l, text };
  });
  return { lines: out, repairs };
}
