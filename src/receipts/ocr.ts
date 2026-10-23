// Reader C: prepare the photo, OCR it with tesseract.js (wasm, no system binaries), structure the OCR
// text with a text-only model call, and place personal data by matching it to OCR word boxes.

import os from "node:os";
import path from "node:path";
import type { CurrencyCode } from "../core/types";
import { NOVA_MODELS, minorUnits, type Options } from "./bedrock";
import { prepImage, type Box, type PrepOptions } from "./prep";
import { structureText, validateReceipt } from "./structure";
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
}
export interface OcrEngine {
  recognize(png: Uint8Array, languages: string[]): Promise<OcrLine[]>;
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
    // "3, 000" is how a thousands separator comes out of OCR.
    .replace(/(?<=\d[,.]) (?=\d{3}\b)/g, "")
    .replace(/\s+$/, "");

/** The engine used in production and in the benchmark. Data files come from `langPath` (vendored traineddata). */
export class TesseractEngine implements OcrEngine {
  private workers = new Map<string, Promise<import("tesseract.js").Worker>>();
  constructor(
    private readonly langPath: string,
    private readonly cachePath = path.join(os.tmpdir(), "tesseract-cache"),
  ) {}

  private worker(langs: string) {
    let w = this.workers.get(langs);
    if (!w) {
      w = import("tesseract.js").then((t) => t.createWorker(langs, 1, { langPath: this.langPath, gzip: false, cachePath: this.cachePath }));
      this.workers.set(langs, w);
    }
    return w;
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
          lines.push({ text, box: frac(line.bbox), words: line.words.map((w) => ({ text: w.text, box: frac(w.bbox) })) });
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

/**
 * Amounts are the one thing a reader must not invent. A model that structures OCR text sometimes
 * multiplies a quantity into the amount (798 x 6 = 4788). An amount that is not printed anywhere in the OCR
 * text is replaced by the last number of the OCR row that holds the product's name; when no row can be
 * matched the amount is left alone. Amounts that do appear in the text are never touched.
 */
export function groundAmounts<T extends { rawText: string; amountMinor: unknown }>(lines: T[], ocr: OcrLine[], exponent: number): T[] {
  const printed = new Set(ocr.flatMap((l) => ocrNumbers(l.text, exponent)).flatMap((n) => [n, Math.abs(n)]));
  return lines.map((l) => {
    if (typeof l.amountMinor !== "number" || printed.has(l.amountMinor)) return l;
    const name = letters(l.rawText);
    if (name.length < 2) return l;
    let best: { score: number; text: string } | null = null;
    for (const row of ocr) {
      const rowLetters = letters(row.text);
      // The product's name is a prefix of the OCR row or the other way round, or the two are alike.
      const score = rowLetters.includes(name) || name.includes(rowLetters) ? 1 : similarity(name, rowLetters);
      if (score >= 0.6 && (!best || score > best.score)) best = { score, text: row.text };
    }
    const last = best ? ocrNumbers(best.text, exponent).at(-1) : undefined;
    return last === undefined ? l : { ...l, amountMinor: last };
  });
}

export class OcrNovaReader implements ReceiptReader {
  private readonly o: Required<Options>;
  private readonly prep: PrepOptions;
  constructor(opts: Options & { engine: OcrEngine; prep?: PrepOptions }) {
    const { engine, prep, ...rest } = opts;
    this.o = { modelId: NOVA_MODELS.lite, maxTokens: 4096, ...rest };
    this.engine = engine;
    // Scale 1.5 read amounts about as well as 1 and 2 (91 / 91 / 89 % of the benchmark's line amounts) and text slightly better than 1.
    this.prep = { scale: 1.5, ...prep };
  }
  private readonly engine: OcrEngine;

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    const what = `ocr read (${this.o.modelId})`;
    const prepared = prepImage(image, this.prep);
    const lines = await this.engine.recognize(prepared.png(), hint.languages);
    const text = lines.map((l) => l.text).join("\n");
    const s = await structureText(this.o, { what: `${what}: structure`, source: "ocr", text, hint });
    const piiRows = Array.isArray(s.obj.pii) ? (s.obj.pii as { kind: string; text: string }[]) : [];
    const exp = String(s.obj.currency) === "JPY" ? 0 : 2;
    const grounded = Array.isArray(s.obj.lines) ? { lines: groundAmounts(s.obj.lines as { rawText: string; amountMinor: unknown }[], lines, exp) } : {};
    const pii = piiRows.map((p) => {
      const box = locateText(lines, p.text);
      return { ...p, bbox: box ? prepared.toOriginal(box) : null };
    });
    const usage: ModelUsage = s.usage;
    return { receipt: validateReceipt({ ...s.obj, ...grounded, pii }, what, usage, { ocr: text, structured: s.answer }), usage };
  }
}
