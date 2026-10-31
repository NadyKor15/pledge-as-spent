// Reader C: prepare the photo, OCR it with tesseract.js (wasm, no system binaries), structure the OCR
// text with a text-only model call, and place personal data by matching it to OCR word boxes.

import os from "node:os";
import path from "node:path";
import type { CurrencyCode } from "../core/types";
import { NOVA_MODELS, minorUnits, type Options } from "./bedrock";
import { cleanLines, isNonProductRow, isQtyRow, qtyRow } from "./clean";
import { readNumbers } from "./numbers";
import { anchorPii, totalRow } from "./pii";
import { prepImage, type Box, type PrepOptions } from "./prep";
import { REREAD_BELOW_CONFIDENCE, repairDigits, rereadDoubtfulRows } from "./rows";
import { structureText, sumUsage, validateReceipt } from "./structure";
import { foldText, similarity } from "./text";
import type { ModelUsage, ReceiptImage, ReceiptReader } from "./types";

export interface OcrWord {
  text: string;
  /** Fractions of the image that was OCR'd. */
  box: Box;
}
export interface OcrLine {
  text: string;
  box: Box;
  words: OcrWord[];
  /** The engine's own confidence in this row, 0..100, when it gives one. */
  confidence?: number;
  /** The text comes from a second, stretched reading: a garbled row, so a translation made from it is only a guess. */
  reread?: boolean;
}
export interface OcrEngine {
  recognize(png: Uint8Array, languages: string[]): Promise<OcrLine[]>;
  /** Reads one row cut out of the photo. Optional: engines without it skip the row repairs. */
  recognizeRow?(png: Uint8Array, languages: string[]): Promise<{ text: string; confidence: number }>;
  close(): Promise<void>;
}

/** Tesseract language codes for the languages a hint names; English is always included (amounts, Latin names). */
export function tesseractLanguages(languages: string[]): string {
  const map: Record<string, string> = { ja: "jpn", tr: "tur", es: "spa", en: "eng" };
  const codes = new Set(languages.map((l) => map[l.toLowerCase()]).filter((x): x is string => !!x));
  codes.add("eng");
  return [...codes].sort().join("+");
}

const CJK = "\\u3000-\\u9fff\\uff00-\\uffef";
/** OCR puts spaces between Japanese characters that are not in the print, and writes the yen sign as a backslash. */
export const tidyOcrText = (s: string) =>
  s
    .replace(new RegExp(`(?<=[${CJK}]) +(?=[${CJK}])`, "g"), "")
    // Tesseract reads the yen sign as a backslash (the old Japanese code page put the yen sign there).
    .replace(/\\(?=\d)/g, "¥")
    // "3, 000" and "6 , 431" are how a thousands separator comes out of OCR.
    .replace(/(?<=\d) ?([,.]) ?(?=\d{3}\b)/g, "$1")
    // The edge of the paper comes out as a stray bar or bracket after the last word.
    .replace(/\s+[|\][>~]+\s*$/, "")
    .replace(/\s+$/, "");

/** The engine used in production and in the benchmark. Data files come from `langPath` (vendored traineddata). */
export class TesseractEngine implements OcrEngine {
  private workers = new Map<string, Promise<import("tesseract.js").Worker>>();
  constructor(
    private readonly langPath: string,
    private readonly cachePath = path.join(os.tmpdir(), "tesseract-cache"),
  ) {}

  private worker(langs: string, singleRow = false) {
    const key = singleRow ? `row:${langs}` : langs;
    let w = this.workers.get(key);
    if (!w) {
      w = import("tesseract.js").then(async (t) => {
        const worker = await t.createWorker(langs, 1, { langPath: this.langPath, gzip: false, cachePath: this.cachePath });
        if (singleRow) await worker.setParameters({ tessedit_pageseg_mode: t.PSM.SINGLE_LINE });
        return worker;
      });
      this.workers.set(key, w);
    }
    return w;
  }

  async recognizeRow(png: Uint8Array, languages: string[]) {
    // A row is read without English: on a lone Japanese row the English model turns kana into Latin letters.
    const codes = tesseractLanguages(languages).split("+").filter((c) => c !== "eng");
    const worker = await this.worker(codes.join("+") || "eng", true);
    const { data } = await worker.recognize(Buffer.from(png));
    return { text: tidyOcrText(data.text.replace(/\n/g, " ")), confidence: data.confidence };
  }

  async recognize(png: Uint8Array, languages: string[]): Promise<OcrLine[]> {
    const worker = await this.worker(tesseractLanguages(languages));
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
    const lines: OcrLine[] = [];
    // Image size is needed to turn pixel boxes into fractions; the PNG header has it.
    const iw = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16);
    const ih = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(20);
    const frac = (b: { x0: number; y0: number; x1: number; y1: number }): Box => ({ x: b.x0 / iw, y: b.y0 / ih, w: (b.x1 - b.x0) / iw, h: (b.y1 - b.y0) / ih });
    for (const block of data.blocks ?? [])
      for (const para of block.paragraphs)
        for (const line of para.lines) {
          const text = tidyOcrText(line.text.replace(/\n/g, " "));
          if (text.trim() === "") continue;
          lines.push({ text, box: frac(line.bbox), words: line.words.map((w) => ({ text: w.text, box: frac(w.bbox) })), confidence: line.confidence });
        }
    return lines.sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  }

  async close() {
    await Promise.all([...this.workers.values()].map(async (w) => (await w).terminate()));
    this.workers.clear();
  }
}

/**
 * The OCR box that best matches a piece of text: a run of consecutive words in one line. A label in front
 * of a number ("会員番号 3216 2141 5525") is not part of the number's box, so the text is also tried from
 * its first digit-bearing word. Null when nothing is close.
 */
export function locateText(lines: OcrLine[], text: string, minScore = 0.7): Box | null {
  const tokens = text.split(/\s+/);
  const firstDigit = tokens.findIndex((t) => /\d/.test(t));
  const targets = [text, ...(firstDigit > 0 ? [tokens.slice(firstDigit).join(" ")] : [])];
  let best: { score: number; area: number; box: Box } | null = null;
  for (const t of targets) {
    const target = foldText(t);
    if (target.length < 3) continue;
    for (const line of lines)
      for (let i = 0; i < line.words.length; i++) {
        let joined = "";
        for (let j = i; j < Math.min(line.words.length, i + 8); j++) {
          joined += foldText(line.words[j].text);
          if (joined === "") continue;
          // A mask such as ************9591 is read as noise plus the digits: the visible part counts as a match.
          const score = joined.includes(target) ? 0.95 : target.length >= 6 && joined.length >= 4 && target.includes(joined) && joined.length >= target.length * 0.6 ? 0.8 : similarity(target, joined);
          if (score < minScore) continue;
          const ws = line.words.slice(i, j + 1);
          const x0 = Math.min(...ws.map((w) => w.box.x));
          const y0 = Math.min(...ws.map((w) => w.box.y));
          const x1 = Math.max(...ws.map((w) => w.box.x + w.box.w));
          const y1 = Math.max(...ws.map((w) => w.box.y + w.box.h));
          const area = (x1 - x0) * (y1 - y0);
          if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && area < best.area)) best = { score, area, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
        }
      }
  }
  return best?.box ?? null;
}

const NUMBER = /[-−]?\s*[¥￥$€₺£]?\s*\d[\d.,]*\d|[-−]?\s*[¥￥$€₺£]?\s*\d/g;

/** Every number printed in the OCR text, as minor units for the currency (signs kept). */
function ocrNumbers(text: string, exponent: number): number[] {
  return (text.match(NUMBER) ?? []).map((t) => minorUnits(t, exponent)).filter((n): n is number => typeof n === "number");
}

const letters = (s: string) => foldText(s.replace(/\d+/g, ""));

type ModelLine = { rawText: string; amountMinor: unknown; unitPriceMinor?: unknown; qty?: unknown; translationEn?: unknown };

const lastNumber = (text: string, exponent: number) => ocrNumbers(text, exponent).at(-1) ?? null;

/** A row ending in an amount: a currency sign or two decimals, then at most one tax mark. */
// The yen sign, also as OCR reads it, makes any number an amount; other currencies print decimals. ("#14" is a store number.)
const AMOUNT_ROW = /(?:[¥￥\\]\s*-?\s*\d[\d.,]*|(?<![A-Z])Y\d[\d.,]*|\d[.,]\d{2})\s*\S?\s*\)?\s*(?:EUR)?\s*$/;
const TRAILING_AMOUNT = /\s*[¥￥$€₺*Y\\#]*\s*-?\s*\d[\d.,]*\s*\S?\s*(?:EUR)?\s*$/;

/** A Turkish row prints its tax rate before the amount; OCR makes %20 into "«20" or "420". */
const TAX_RATE_COLUMN = /\s+[%«»"“”#^*]?[45]?(?:1|10|20)$/;

/** The product name of a row that ends in an amount. */
const rowName = (text: string) => text.replace(TRAILING_AMOUNT, "").trim().replace(TAX_RATE_COLUMN, "");

/** How well a model's line text matches an OCR row: the shorter of the two against the same-length start of the other. */
function rowScore(name: string, row: string): number {
  if (name.length < 2 || row.length < 2) return 0;
  const short = name.length <= row.length ? name : row;
  const long = name.length <= row.length ? row : name;
  return similarity(short, long.slice(0, short.length));
}

/**
 * Numbers are the one thing a reader must not invent. A model that structures text sometimes multiplies a
 * quantity into the amount (798 x 6 = 4788), divides an amount into a unit price (23.97 / 8) or takes a unit
 * price for the amount. So each line is matched to its OCR row (in order, each row once) and:
 * - the amount is the last number printed on that row (a line without a matching row keeps its amount if that
 *   number is printed anywhere in the text, and is left alone otherwise);
 * - the text is the row's, with the rows below it that continue the name (a pack size, "2Lペット"): a model tends to
 *   tidy digits away, and the pack size is what the quantity for a need is counted from;
 * - the quantity and unit price are those of the row below the product ("4点 x 単118"); a product without such a row
 *   was bought once, whatever number a model took from its name;
 * - a unit price that is not printed anywhere in the text becomes unknown (null);
 * - a quantity that is not above zero becomes unknown, and one that does not agree with amount / unit price
 *   (OCR reads "10点" as "104") is replaced by amount / unit price when that divides evenly.
 * `rows` is the OCR text or the transcription.
 */
export function groundNumbers<T extends ModelLine>(lines: T[], rows: { text: string }[], exponent: number): T[] {
  return groundLines(lines, rows, exponent).lines;
}

function groundLines<T extends ModelLine>(lines: T[], rows: { text: string; reread?: boolean }[], exponent: number, only?: Set<number>): { lines: T[]; rowOf: number[] } {
  const nums = rows.map((r) => ocrNumbers(r.text, exponent));
  const printed = new Set(nums.flat().flatMap((n) => [n, Math.abs(n)]));
  const rowLetters = rows.map((r) => letters(r.text));
  const usable = rows.map((r, i) => nums[i].length > 0 && !isQtyRow(r.text) && (!only || only.has(i)));
  const used = new Set<number>();
  const rowOf: number[] = [];
  let prev = -1;
  const out = lines.map((l) => {
    const out: T = { ...l };
    let best = -1;
    if (typeof l.amountMinor === "number") {
      const name = letters(l.rawText);
      // Rows come in print order: look ahead of the previous match first, then anywhere unused. Among rows that
      // match about equally well (a trailing tax code is enough to differ) the first one is the product's.
      for (const range of [[prev + 1, rows.length], [0, rows.length]]) {
        const scores = rows.map((_, i) => (i < range[0] || i >= range[1] || used.has(i) || !usable[i] ? 0 : rowScore(name, rowLetters[i])));
        const top = Math.max(...scores);
        if (top > 0.6) best = scores.findIndex((v) => v >= top - 0.1);
        if (best >= 0) break;
      }
      if (best >= 0) {
        used.add(best);
        prev = best;
        const last = nums[best].at(-1)!;
        out.amountMinor = l.amountMinor < 0 && last > 0 ? -last : last;
        const fromRow = rowFields(rows, best, exponent);
        out.rawText = fromRow.rawText || l.rawText;
        out.qty = fromRow.qty;
        if (fromRow.unitPriceMinor !== null) out.unitPriceMinor = fromRow.unitPriceMinor;
        // A confident English name made from a garbled row misleads the classifier more than none at all.
        if (rows[best].reread) out.translationEn = "";
      }
    }
    rowOf.push(best);
    if (typeof out.unitPriceMinor === "number" && !printed.has(out.unitPriceMinor)) out.unitPriceMinor = null;
    const unit = out.unitPriceMinor;
    const amount = out.amountMinor;
    if (typeof out.qty === "number" && !(out.qty > 0)) out.qty = null;
    if (typeof unit === "number" && unit > 0 && typeof amount === "number" && amount > 0 && amount % unit === 0 && out.qty !== amount / unit) out.qty = amount / unit;
    return out;
  });
  return { lines: out, rowOf };
}

/** What the printed rows say about the product whose row is `at`. */
function rowFields(rows: { text: string }[], at: number, exponent: number) {
  const below = rowsBelow(rows, at);
  const name = rowName(rows[at].text);
  const unit = below.qty ? minorUnits(below.qty.unit, exponent) : null;
  return { rawText: name === "" ? "" : [name, ...below.names].join(" "), qty: below.qty ? below.qty.qty : 1, unitPriceMinor: typeof unit === "number" ? unit : null };
}

/** What follows a product's row up to the next amount: rows that continue its name, and its quantity row. */
function rowsBelow(rows: { text: string }[], at: number): { names: string[]; qty: ReturnType<typeof qtyRow> } {
  const names: string[] = [];
  let qty: ReturnType<typeof qtyRow> = null;
  for (let i = at + 1; i < rows.length && i <= at + 3; i++) {
    const text = rows[i].text;
    if (isQtyRow(text)) {
      qty ??= qtyRow(text);
      continue;
    }
    if (AMOUNT_ROW.test(text) || isNonProductRow(text)) break;
    names.push(text.trim());
  }
  return { names, qty };
}

/**
 * The rows that are products: from the first row that ends in an amount down to the first totals row. A model
 * drops a row now and then and turns a continuation or a quantity row into a line of its own; the rows do neither.
 */
function productRows(rows: { text: string; confidence?: number }[], exponent: number): number[] {
  const texts = rows.map((r) => r.text);
  const amount = (t: string) => AMOUNT_ROW.test(t) && !isQtyRow(t);
  const negative = (t: string) => /-\s*[¥￥$€₺*]|[¥￥$€₺*]\s*-/.test(t);
  const total = totalRow(rows);
  const out: number[] = [];
  let sum = 0;
  for (const [i, t] of texts.entries()) {
    if (i === total) break;
    if (!amount(t)) continue;
    if (isNonProductRow(t) && !negative(t)) break;
    const n = lastNumber(t, exponent) ?? 0;
    // A subtotal whose label OCR could not read: a doubtful row with exactly the sum of the rows above it.
    if (out.length >= 2 && n === sum && (rows[i].confidence ?? 100) < REREAD_BELOW_CONFIDENCE) break;
    sum += negative(t) ? -Math.abs(n) : n;
    out.push(i);
  }
  return out;
}

const SUBTOTAL_LABEL = /小計|sub\s*total|ara\s*toplam|subtotal/i;
const TAX_ROW = /外税|消費税|sales\s*tax/i;

/**
 * Totals as printed, against the lines: a model mixes up the rows of a tax table, and the arithmetic is what decides.
 * The total is the number on the total row, or, when OCR misread that one, the same amount on a payment row below it
 * if that is the one the lines add up to. Tax on top is believed only when the printed tax rows close the gap.
 * A printed subtotal that disagrees with lines that already reach the total was misread, so it is left out.
 */
function printedTotals(rows: { text: string }[], lines: { amountMinor: number }[], exponent: number) {
  const at = totalRow(rows);
  if (at < 0) return {};
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const subRow = rows.findIndex((r) => SUBTOTAL_LABEL.test(r.text));
  const taxRows = rows.slice(Math.max(0, subRow), at).filter((r) => TAX_ROW.test(r.text));
  const tax = taxRows.reduce((s, r) => s + (lastNumber(r.text, exponent) ?? 0), 0);
  const fits = (n: number) => n === sum || (tax > 0 && Math.abs(n - sum - tax) <= taxRows.length);
  const shown = [at, at + 1, at + 2, at + 3].flatMap((i) => (rows[i] && AMOUNT_ROW.test(rows[i].text) ? [lastNumber(rows[i].text, exponent)] : [])).filter((n): n is number => n !== null);
  if (shown.length === 0) return {};
  const totalMinor = shown.find(fits) ?? shown[0];
  const onTop = tax > 0 && totalMinor !== sum && fits(totalMinor);
  const sub = subRow >= 0 ? lastNumber(rows[subRow].text, exponent) : null;
  return { totalMinor, ...(onTop ? { taxIncluded: false, taxMinor: tax } : {}), subtotalMinor: fits(totalMinor) && sub !== sum ? null : sub };
}

/**
 * Cleans a structured receipt against the text it came from: lines grounded in the printed numbers and stripped
 * of rows that are not products, every product row present once, and totals taken from their rows.
 * `rows` is the OCR text or transcription.
 */
export function groundReceipt(obj: Record<string, unknown>, rows: { text: string; reread?: boolean; confidence?: number }[]): Record<string, unknown> {
  const exp = String(obj.currency) === "JPY" ? 0 : 2;
  const out = { ...obj };
  if (!Array.isArray(obj.lines)) return out;
  const products = productRows(rows, exp);
  if (products.length === 0) {
    out.lines = cleanLines(groundNumbers(obj.lines as ModelLine[], rows, exp));
    if (out.subtotalMinor !== null && out.subtotalMinor !== undefined && !rows.some((r) => SUBTOTAL_LABEL.test(r.text))) out.subtotalMinor = null;
    return out;
  }
  const { lines, rowOf } = groundLines(obj.lines as ModelLine[], rows, exp, new Set(products));
  const clean = cleanLines(
    products.flatMap((i) => {
      const k = rowOf.indexOf(i);
      if (k >= 0) return [lines[k]];
      const amountMinor = lastNumber(rows[i].text, exp);
      return amountMinor === null ? [] : [{ ...rowFields(rows, i, exp), amountMinor, translationEn: "", taxRateBp: null }];
    }),
  );
  out.lines = clean;
  return { ...out, subtotalMinor: null, ...printedTotals(rows, clean as { amountMinor: number }[], exp) };
}

const realDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number | string) => String(n).padStart(2, "0");

/**
 * The purchase date and time printed on one of the rows, ISO. Models swap day and month on 05/11/2026, so the order
 * is decided here: month first on US receipts, day first elsewhere, unless the number cannot be a month.
 */
export function printedDate(rows: string[], languages: string[]): string | null {
  const monthFirst = languages[0] === "en";
  for (const row of rows) {
    const t = row.normalize("NFKC");
    const iso = (y: number, m: number, d: number, time: RegExpMatchArray | null) => {
      if (!realDate(y, m, d)) return null;
      let h = time ? Number(time[1]) : 0;
      if (time?.[3]?.toLowerCase() === "pm" && h < 12) h += 12;
      if (time?.[3]?.toLowerCase() === "am" && h === 12) h = 0;
      return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${time ? time[2] : "00"}:00`;
    };
    const time = t.match(/(?<!\d)(\d{1,2})\s*:\s*(\d{2})(?::\d{2})?\s*(am|pm)?/i);
    const ja = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (ja) {
      const r = iso(Number(ja[1]), Number(ja[2]), Number(ja[3]), time);
      if (r) return r;
      continue;
    }
    const compact = t.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
    if (compact) {
      const r = iso(Number(compact[1]), Number(compact[2]), Number(compact[3]), time);
      if (r) return r;
    }
    const m = t.match(/(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](20\d{2})(?!\d)/);
    if (!m) continue;
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const r = monthFirst ? (iso(y, a, b, time) ?? iso(y, b, a, time)) : (iso(y, b, a, time) ?? iso(y, a, b, time));
    if (r) return r;
  }
  return null;
}

/** What the steps saw, for reading a benchmark run afterwards. */
export interface ReadTrace {
  ocr: string[];
  reread: string[];
  photoNumbers: string[];
  numbersFailed: number;
  repairs: { from: string; to: string }[];
}

/** A page that OCR cannot make rows of: fewer rows than any receipt has, or rows it does not believe itself. */
export function unreadablePage(lines: OcrLine[]): boolean {
  if (lines.length < 6) return true;
  const known = lines.filter((l) => l.confidence !== undefined);
  return known.length === lines.length && known.reduce((s, l) => s + l.confidence!, 0) / known.length < 35;
}

export class OcrNovaReader implements ReceiptReader {
  private readonly o: Required<Options>;
  private readonly prep: PrepOptions;
  private readonly numbersModelId: string;
  constructor(opts: Options & { engine: OcrEngine; prep?: PrepOptions; numbersModelId?: string; trace?: (t: ReadTrace) => void }) {
    const { engine, prep, numbersModelId, trace, ...rest } = opts;
    this.trace = trace;
    this.o = { modelId: NOVA_MODELS.lite, maxTokens: 4096, ...rest };
    this.engine = engine;
    // Scale 1.5 read amounts about as well as 1 and 2 (91 / 91 / 89 % of the benchmark's line amounts) and text slightly better than 1.
    this.prep = { scale: 1.5, ...prep };
    this.numbersModelId = numbersModelId ?? this.o.modelId;
  }
  private readonly engine: OcrEngine;
  private readonly trace?: (t: ReadTrace) => void;

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    const what = `ocr read (${this.o.modelId})`;
    const prepared = prepImage(image, this.prep);
    const first = await this.engine.recognize(prepared.png(), hint.languages);
    if (unreadablePage(first)) {
      const usage: ModelUsage = { model: "none", tokensIn: 0, tokensOut: 0, usdCeiling: 0, usdActual: 0 };
      return { receipt: validateReceipt({ merchantName: "", merchantAddress: null, country: null, currency: hint.currency, purchasedAt: null, receiptNumber: null, lines: [], subtotalMinor: null, taxMinor: null, taxIncluded: null, totalMinor: 0, pii: [], readability: "unreadable" }, what, usage, null), usage };
    }
    const reread = await rereadDoubtfulRows(prepared.image, first, this.engine, hint.languages);

    const usages: ModelUsage[] = [];
    let answer = "";
    let text = "";
    let candidate: Record<string, unknown>;
    try {
      // The photo down to the total: the rows below it hold the card and the customer. A larger scale than the OCR's:
      // at 1.5 Nova Lite skipped whole rows, at 2 it kept them.
      const total = totalRow(reread);
      const bottom = total >= 0 ? reread[total].box.y + reread[total].box.h * 1.4 : 1;
      const numbers = await readNumbers({ ...this.o, modelId: this.numbersModelId, maxTokens: 1500 }, prepImage(image, { ...this.prep, scale: 2 }).tiles(undefined, bottom), what);
      usages.push(...numbers.usage);
      const { lines, repairs } = repairDigits(reread, numbers.rows);
      text = lines.map((l) => l.text).join("\n");
      this.trace?.({ ocr: first.map((l) => l.text), reread: reread.map((l) => l.text), photoNumbers: numbers.rows, numbersFailed: numbers.failed, repairs });
      const s = await structureText(this.o, { what: `${what}: structure`, source: "ocr", text, hint });
      usages.push(s.usage);
      answer = s.answer;
      const grounded = groundReceipt(s.obj, lines);
      // The photo's copy first: Nova keeps a date's digits. No copy means the date was not checked, and OCR misreads
      // dates, so a person looks instead.
      const date = printedDate(numbers.rows, hint.languages) ?? printedDate(text.split("\n"), hint.languages);
      grounded.purchasedAt = numbers.rows.length === 0 ? null : (date ?? grounded.purchasedAt);

      const anchors = anchorPii(lines).map((p) => ({ ...p, bbox: p.bbox && prepared.toOriginal(p.bbox) }));
      const piiRows = Array.isArray(s.obj.pii) ? (s.obj.pii as { kind: string; text: string }[]) : [];
      // Rows the position rules did not place. One standing above the total is the store's own phone or tax number.
      const totalY = total >= 0 ? lines[total].box.y : 0;
      const fromModel = piiRows
        .filter((p) => !anchors.some((a) => a.kind === p.kind))
        .map((p) => ({ p, box: locateText(lines, p.text) }))
        .filter(({ box }) => !box || box.y >= totalY)
        .map(({ p, box }) => ({ ...p, bbox: box ? prepared.toOriginal(box) : null }));
      candidate = { ...grounded, pii: [...anchors, ...fromModel] };
    } catch (e) {
      // Whatever failed, the calls already made were paid for.
      if (e && typeof e === "object") {
        const err = e as { usage?: ModelUsage; raw?: unknown };
        const own = err.usage && !usages.includes(err.usage) ? [err.usage] : [];
        err.usage = sumUsage([...usages, ...own]);
        err.raw ??= { ocr: text };
      }
      throw e;
    }
    const usage = sumUsage(usages);
    return { receipt: validateReceipt(candidate, what, usage, { ocr: text, structured: answer }), usage };
  }
}
