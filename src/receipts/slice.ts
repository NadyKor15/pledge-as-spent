// The printed rows of a receipt, found with plain image processing (pure JS, no native code), and the numbered
// sheet of their cuts that the second reading looks at. A model's own coordinates are never used: what it reads
// next to a number belongs to that row's exact pixels, so a row can later be shown or closed by its pixels alone.
// The approach is ported from the author's own BillRadar sheet pieces (started October 26, 2026), rewritten in
// TypeScript for receipts: rows across the whole paper instead of table cells.

import jpeg from "jpeg-js";
import { prepImage, type Prepared, type Rgba } from "./prep";
import type { Band, ReceiptImage } from "./types";

/**
 * One printed row (the Band type, src/receipts/types.ts): `y0`/`y1` are pixel rows of the straightened, enlarged paper
 * (reading order); `quad` is the same row on the ORIGINAL photo, in its pixels, corners clockwise from top left.
 * A tilted photo makes it a slanted strip.
 */
export type { Band };

export interface Sheet {
  bytes: Uint8Array;
  mediaType: "image/jpeg";
  /** Band indexes on this sheet, first and last. */
  first: number;
  last: number;
}

export interface Slicing {
  bands: Band[];
  tiltDeg: number;
  /** Size of the original photo, in pixels. */
  width: number;
  height: number;
  sheets: Sheet[];
}

export interface SliceOptions {
  /** Height of one cut on the sheet, in pixels. */
  rowHeight?: number;
  /** Cuts per sheet image: more shrink past what a model reads well. */
  perSheet?: number;
}

const ROW_H = 40;
const GAP = 10;
const NUMBER_W = 84;
const SHEET_W = 1200;
const PER_SHEET = 34;

const grey = (d: Uint8Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Mean of the grey image over a (2r+1)-square around every pixel, through an integral image. */
function localMean(g: Float32Array, w: number, h: number, r: number): Float32Array {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function otsu(hist: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0;
  let sB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sB += t * hist[t];
    const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/**
 * Ink: a pixel clearly darker than its neighbourhood, on paper. Paper is where most pixels around are bright (Otsu
 * between desk and paper), so the dark desk right next to the paper's edge is not ink, and neither is a shadow across
 * the paper (it darkens the neighbourhood too). The paper's columns bound the search, so torn edges stay out.
 */
export function inkMask(img: Rgba): { ink: Uint8Array; paper: Float32Array; paperX0: number; paperX1: number } {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = grey(data, i * 4);
  const r = Math.max(12, Math.round(Math.min(w, h) / 30));
  const bg = localMean(g, w, h, r);
  // Never so high that a shadow on the paper counts as desk: a shadow across the right half once cut the amounts off.
  const hist = new Array(256).fill(0);
  for (let i = 0; i < w * h; i++) hist[Math.min(255, Math.max(0, Math.round(g[i])))]++;
  const brightAbove = Math.min(170, Math.max(100, otsu(hist, w * h)));
  const bright = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) bright[i] = g[i] > brightAbove ? 1 : 0;
  const paper = localMean(bright, w, h, r);
  const PAPER = 0.55;
  const cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paper[y * w + x] > PAPER) cols[x]++;
  const colMax = Math.max(...cols);
  let paperX0 = 0;
  let paperX1 = w;
  const onPaper = (x: number) => cols[x] >= 0.5 * colMax;
  while (paperX0 < w && !onPaper(paperX0)) paperX0++;
  while (paperX1 > paperX0 && !onPaper(paperX1 - 1)) paperX1--;
  // Stay clear of the paper's edge: a zigzag tear reads as ink.
  const pad = Math.round((paperX1 - paperX0) * 0.02);
  paperX0 += pad;
  paperX1 -= pad;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = paperX0; x < paperX1; x++) {
      const i = y * w + x;
      if (paper[i] > PAPER && g[i] < bg[i] - Math.max(28, 0.18 * bg[i])) ink[i] = 1;
    }
  return { ink, paper, paperX0, paperX1 };
}

/** Runs of rows with ink: [start, end) pixel rows, with the ink's left and right columns. */
function rowRuns(ink: Uint8Array, w: number, h: number, x0: number, x1: number) {
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) n += ink[y * w + x];
    prof[y] = n;
  }
  const min = Math.max(2, 0.004 * (x1 - x0));
  const runs: { y0: number; y1: number }[] = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && prof[y] >= min;
    if (on && start < 0) start = y;
    else if (!on && start >= 0) {
      runs.push({ y0: start, y1: y });
      start = -1;
    }
  }
  return { runs, prof };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The printed rows of the prepared paper, top to bottom. Rows a pixel or two apart (accents, dakuten) join; a run
 * taller than two rows of type is split at its emptiest row; specks and dotted rules lower than a third of a row
 * of type are dropped (they carry no text).
 */
export function findRows(img: Rgba): { y0: number; y1: number; x0: number; x1: number }[] {
  const { ink, paper, paperX0, paperX1 } = inkMask(img);
  const w = img.width;
  const h = img.height;
  if (paperX1 - paperX0 < 10) return [];
  const { runs, prof } = rowRuns(ink, w, h, paperX0, paperX1);
  if (!runs.length) return [];
  // Join runs split by a hairline gap.
  const joined: { y0: number; y1: number }[] = [];
  for (const r of runs) {
    const last = joined[joined.length - 1];
    if (last && r.y0 - last.y1 <= 2) last.y1 = r.y1;
    else joined.push({ ...r });
  }
  const typical = median(joined.map((r) => r.y1 - r.y0).filter((t) => t >= 6));
  const rowH = Math.max(6, typical);
  // Split runs that hold two or more rows of type touching each other.
  const split: { y0: number; y1: number }[] = [];
  const cut = (r: { y0: number; y1: number }) => {
    const ht = r.y1 - r.y0;
    if (ht <= 1.7 * rowH) return split.push(r);
    const lo = r.y0 + Math.round(0.6 * rowH);
    const hi = r.y1 - Math.round(0.6 * rowH);
    let at = lo;
    for (let y = lo; y < hi; y++) if (prof[y] < prof[at]) at = y;
    cut({ y0: r.y0, y1: at });
    cut({ y0: at + 1, y1: r.y1 });
  };
  joined.forEach(cut);
  const out: { y0: number; y1: number; x0: number; x1: number }[] = [];
  for (const r of split) {
    if (r.y1 - r.y0 < Math.max(3, 0.35 * rowH)) continue;
    let x0 = paperX1;
    let x1 = paperX0;
    let n = 0;
    for (let y = r.y0; y < r.y1; y++)
      for (let x = paperX0; x < paperX1; x++)
        if (ink[y * w + x]) {
          n++;
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
        }
    if (n < 6) continue;
    // A solid dark line across the whole paper is the desk at a cropped edge or a tear, never a row of print.
    let widest = 0;
    for (let y = r.y0; y < r.y1; y++) widest = Math.max(widest, prof[y]);
    if (widest >= 0.85 * (paperX1 - paperX0)) continue;
    // The torn top or bottom edge of the paper: much of the row's width is desk, not paper.
    let desk = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = paperX0; x < paperX1; x++) if (paper[y * w + x] < 0.5) desk++;
    if (desk > 0.15 * (r.y1 - r.y0) * (paperX1 - paperX0)) continue;
    out.push({ ...r, x0, x1 });
  }
  return out;
}

// 5x7 digits for the numbers on the sheet: drawn with plain pixels, so no font file and no native code.
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

function fillRect(page: Rgba, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) {
  for (let y = Math.max(0, y0); y < Math.min(page.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(page.width, x0 + w); x++) {
      const i = (y * page.width + x) * 4;
      page.data[i] = rgb[0];
      page.data[i + 1] = rgb[1];
      page.data[i + 2] = rgb[2];
      page.data[i + 3] = 255;
    }
}

export function drawNumber(page: Rgba, n: number, x: number, y: number, px: number) {
  let cx = x;
  for (const ch of String(n)) {
    const glyph = DIGITS[ch];
    glyph.forEach((row, gy) => [...row].forEach((bit, gx) => bit === "1" && fillRect(page, cx + gx * px, y + gy * px, px, px, [170, 0, 0])));
    cx += 6 * px;
  }
}

/** Bilinear copy of a rectangle of `src` into `dst` at (dx, dy), scaled to dw x dh. */
function paste(src: Rgba, sx0: number, sy0: number, sw: number, sh: number, dst: Rgba, dx: number, dy: number, dw: number, dh: number) {
  for (let y = 0; y < dh; y++) {
    const fy = sy0 + ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(fy)));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = sx0 + ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(fx)));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const o = ((dy + y) * dst.width + dx + x) * 4;
      if (dy + y < 0 || dy + y >= dst.height || dx + x < 0 || dx + x >= dst.width) continue;
      for (let c = 0; c < 3; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c] * (1 - tx) + src.data[(y0 * src.width + x1) * 4 + c] * tx;
        const b = src.data[(y1 * src.width + x0) * 4 + c] * (1 - tx) + src.data[(y1 * src.width + x1) * 4 + c] * tx;
        dst.data[o + c] = Math.round(a * (1 - ty) + b * ty);
      }
      dst.data[o + 3] = 255;
    }
  }
}

/** The numbered sheets: every band's cut, enlarged to one height, down a white page, its number on the left in red. */
export function sheetsOf(prepared: Rgba, bands: Band[], rows: { x0: number; x1: number }[], opts: SliceOptions = {}): Sheet[] {
  const rowH = opts.rowHeight ?? ROW_H;
  const per = opts.perSheet ?? PER_SHEET;
  const out: Sheet[] = [];
  for (let start = 0; start < bands.length; start += per) {
    const part = bands.slice(start, start + per);
    const page: Rgba = { width: SHEET_W, height: part.length * (rowH + GAP) + GAP, data: new Uint8Array(SHEET_W * (part.length * (rowH + GAP) + GAP) * 4).fill(255) };
    part.forEach((b, k) => {
      const r = rows[b.index - 1];
      const y = GAP + k * (rowH + GAP);
      const sx0 = Math.max(0, r.x0 - 4);
      const sx1 = Math.min(prepared.width, r.x1 + 4);
      const sy0 = Math.max(0, b.y0 - 3);
      const sy1 = Math.min(prepared.height, b.y1 + 3);
      const scale = Math.min(rowH / (sy1 - sy0), (SHEET_W - NUMBER_W - 10) / (sx1 - sx0));
      const dw = Math.max(1, Math.round((sx1 - sx0) * scale));
      const dh = Math.max(1, Math.round((sy1 - sy0) * scale));
      drawNumber(page, b.index, 8, y + Math.max(0, Math.round((rowH - 28) / 2)), 4);
      paste(prepared, sx0, sy0, sx1 - sx0, sy1 - sy0, page, NUMBER_W, y + Math.round((rowH - dh) / 2), dw, dh);
      if (k < part.length - 1) fillRect(page, 0, y + rowH + Math.floor(GAP / 2), SHEET_W, 1, [225, 225, 225]);
    });
    out.push({ bytes: jpeg.encode({ data: page.data, width: page.width, height: page.height }, 92).data, mediaType: "image/jpeg", first: part[0].index, last: part[part.length - 1].index });
  }
  return out;
}

/** Band corners on the original photo, in its pixels: the straightened row taken back through crop and rotation. */
function quadOf(prep: Prepared, origW: number, origH: number, x0: number, y0: number, x1: number, y1: number): [number, number][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => {
    const [fx, fy] = prep.pointToOriginal(x, y);
    return [Math.round(fx * origW * 10) / 10, Math.round(fy * origH * 10) / 10] as [number, number];
  });
}

/**
 * Slices a receipt photo into its printed rows. Each band reaches halfway into the white gap above and below it
 * (at most a third of a row of type), so tails of letters stay inside; across, it spans the paper's printed width.
 * Throws when the photo cannot be decoded (WebP has no pure-JS decoder here): the caller then has no second reading.
 */
export function sliceReceipt(image: ReceiptImage, opts: SliceOptions = {}): Slicing {
  const prep = prepImage(image, { scale: 2 });
  const img = prep.image;
  const rows = findRows(img);
  const typical = median(rows.map((r) => r.y1 - r.y0));
  const reach = Math.max(2, Math.round(typical / 3));
  const left = rows.length ? Math.min(...rows.map((r) => r.x0)) : 0;
  const right = rows.length ? Math.max(...rows.map((r) => r.x1)) : img.width;
  const [ow, oh] = originalSize(prep);
  const bands: Band[] = rows.map((r, i) => {
    const above = i === 0 ? r.y0 - reach : Math.max(r.y0 - reach, Math.ceil((rows[i - 1].y1 + r.y0) / 2));
    const below = i === rows.length - 1 ? r.y1 + reach : Math.min(r.y1 + reach, Math.floor((r.y1 + rows[i + 1].y0) / 2));
    const y0 = Math.max(0, above);
    const y1 = Math.min(img.height, below);
    const x0 = Math.max(0, left - reach);
    const x1 = Math.min(img.width, right + reach);
    return { index: i + 1, y0, y1, quad: quadOf(prep, ow, oh, x0, y0, x1, y1) };
  });
  return { bands, tiltDeg: prep.tiltDeg, width: ow, height: oh, sheets: sheetsOf(img, bands, rows, opts) };
}

/**
 * The rows of some bands cut out of the straightened paper, enlarged so a row of type is about 60 pixels high: what the
 * third reading of one disputed line looks at. The preparation is deterministic, so the bands' y fall on the same rows.
 */
export function cutRows(image: ReceiptImage, bands: Band[], rowHeight = 60): { bytes: Uint8Array; mediaType: "image/jpeg" } {
  if (!bands.length) throw new Error("no rows to cut");
  const prep = prepImage(image, { scale: 2 });
  const img = prep.image;
  const y0 = Math.max(0, Math.min(...bands.map((b) => b.y0)) - 4);
  const y1 = Math.min(img.height, Math.max(...bands.map((b) => b.y1)) + 4);
  const typical = median(bands.map((b) => b.y1 - b.y0));
  const scale = Math.max(1, Math.min(3, rowHeight / Math.max(1, typical)));
  const w = Math.round(img.width * scale);
  const h = Math.round((y1 - y0) * scale);
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) };
  paste(img, 0, y0, img.width, y1 - y0, out, 0, 0, w, h);
  return { bytes: jpeg.encode({ data: out.data, width: w, height: h }, 92).data, mediaType: "image/jpeg" };
}

/** The original photo's size, read back from the preparation (its full box maps to the whole photo). */
function originalSize(prep: Prepared): [number, number] {
  return [prep.originalWidth, prep.originalHeight];
}
