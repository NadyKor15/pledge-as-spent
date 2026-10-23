// Deterministic image preparation for the receipt readers, in pure JS (pngjs, jpeg-js; no native code):
// find the paper, crop to it, straighten it, enlarge it, and cut tall receipts into overlapping tiles.
// The coordinates of anything found in the prepared image map back to the original photo.

import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { decodeImage, type Raster } from "./hash";
import type { ReceiptImage } from "./types";

export type Rgba = { width: number; height: number; data: Uint8Array };
export type Box = { x: number; y: number; w: number; h: number };

export interface PrepOptions {
  /** Margin around the paper, as a fraction of its size. */
  margin?: number;
  /** Enlargement of the final image. */
  scale?: number;
  /** Straighten the paper when it is tilted. */
  deskew?: boolean;
}

const gray = (d: Uint8Array | Buffer, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

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

/** Box-average the grey image down so its longer side is about `target` pixels. */
function smallGrey(r: Rgba, target: number) {
  const f = Math.max(1, Math.floor(Math.max(r.width, r.height) / target));
  const w = Math.floor(r.width / f);
  const h = Math.floor(r.height / f);
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += gray(r.data, ((y * f + dy) * r.width + (x * f + dx)) * 4);
      g[y * w + x] = s / (f * f);
    }
  return { g, w, h, f };
}

/** The bounding box (in pixels of `r`) of the bright paper, or the whole image when no paper is found. */
export function findPaper(r: Rgba): { x0: number; y0: number; x1: number; y1: number } {
  const { g, w, h, f } = smallGrey(r, 400);
  const hist = new Array(256).fill(0);
  for (const v of g) hist[Math.round(v)]++;
  let thr = otsu(hist, g.length);
  let bright = 0;
  for (const v of g) if (v > thr) bright++;
  // A light desk makes the first split fall between text and everything else: split the bright part again.
  if (bright / g.length > 0.8) {
    const h2 = new Array(256).fill(0);
    let n = 0;
    for (const v of g) if (v > thr) {
      h2[Math.round(v)]++;
      n++;
    }
    thr = otsu(h2, n);
  }
  const rows = new Array(h).fill(0);
  const cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (g[y * w + x] > thr) {
        rows[y]++;
        cols[x]++;
      }
  const rMax = Math.max(...rows);
  const cMax = Math.max(...cols);
  const ys = rows.map((v, i) => (v >= 0.25 * rMax ? i : -1)).filter((i) => i >= 0);
  const xs = cols.map((v, i) => (v >= 0.25 * cMax ? i : -1)).filter((i) => i >= 0);
  if (!ys.length || !xs.length || rMax < 4 || cMax < 4) return { x0: 0, y0: 0, x1: r.width, y1: r.height };
  return { x0: xs[0] * f, y0: ys[0] * f, x1: Math.min(r.width, (xs[xs.length - 1] + 1) * f), y1: Math.min(r.height, (ys[ys.length - 1] + 1) * f) };
}

function crop(r: Rgba, x0: number, y0: number, x1: number, y1: number): Rgba {
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(r.data.subarray(((y0 + y) * r.width + x0) * 4, ((y0 + y) * r.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/**
 * The tilt of the text lines in degrees (positive: lines run downhill to the right), from the projection
 * profile of dark pixels inside the paper. Searches -6..6 degrees; 0 when the paper is too small to tell.
 */
export function estimateTilt(r: Rgba): number {
  const { g, w, h } = smallGrey(r, 360);
  const hist = new Array(256).fill(0);
  for (const v of g) hist[Math.round(v)]++;
  const thr = otsu(hist, g.length);
  const pts: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++)
      if (g[y * w + x] > thr) {
        if (first < 0) first = x;
        last = x;
      }
    if (first < 0) continue;
    for (let x = first; x <= last; x++) if (g[y * w + x] <= thr) pts.push([x, y]);
  }
  if (pts.length < 200) return 0;
  const score = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const sin = Math.sin(t);
    const cos = Math.cos(t);
    const bins = new Float64Array(h * 2 + w + 8);
    for (const [x, y] of pts) bins[Math.round(y * cos - x * sin + w)]++;
    let s = 0;
    for (const b of bins) s += b * b;
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -6; d <= 6.001; d += 0.5) {
    const s = score(d);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  for (let d = best - 0.5; d <= best + 0.501; d += 0.1) {
    const s = score(d);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return Math.round(best * 10) / 10;
}

/** Rotate by `deg` (positive: clockwise) on a canvas big enough for the result; new pixels are black. */
function rotate(r: Rgba, deg: number): { img: Rgba; ox: number; oy: number } {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const w = Math.ceil(Math.abs(r.width * cos) + Math.abs(r.height * sin));
  const h = Math.ceil(Math.abs(r.width * sin) + Math.abs(r.height * cos));
  const out = new Uint8Array(w * h * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const cx = r.width / 2;
  const cy = r.height / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Inverse map: destination -> source.
      const dx = x - w / 2;
      const dy = y - h / 2;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      if (sx < 0 || sy < 0 || sx >= r.width - 1 || sy >= r.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * r.width + x0) * 4 + c;
        out[(y * w + x) * 4 + c] =
          r.data[i00] * (1 - fx) * (1 - fy) + r.data[i00 + 4] * fx * (1 - fy) + r.data[i00 + r.width * 4] * (1 - fx) * fy + r.data[i00 + r.width * 4 + 4] * fx * fy;
      }
    }
  return { img: { width: w, height: h, data: out }, ox: w / 2 - cx, oy: h / 2 - cy };
}

function enlarge(r: Rgba, scale: number): Rgba {
  if (scale === 1) return r;
  const w = Math.round(r.width * scale);
  const h = Math.round(r.height * scale);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(r.height - 1.001, y / scale);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r.width - 1.001, x / scale);
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const i = (y0 * r.width + x0) * 4;
      for (let c = 0; c < 4; c++) {
        out[(y * w + x) * 4 + c] = r.data[i + c] * (1 - fx) * (1 - fy) + r.data[i + 4 + c] * fx * (1 - fy) + r.data[i + r.width * 4 + c] * (1 - fx) * fy + r.data[i + r.width * 4 + 4 + c] * fx * fy;
      }
    }
  }
  return { width: w, height: h, data: out };
}

export interface Tile {
  bytes: Uint8Array;
  mediaType: "image/jpeg";
  /** Where the tile sits in the prepared image, in pixels. */
  y0: number;
  y1: number;
  /** A box in fractions of this tile -> a box in fractions of the original photo. */
  toOriginal(box: Box): Box;
}

export interface Prepared {
  /** The cropped, straightened, enlarged paper. */
  image: Rgba;
  tiltDeg: number;
  /** A box in fractions of the prepared image -> a box in fractions of the original photo. */
  toOriginal(box: Box): Box;
  png(): Uint8Array;
  /** One tile for a receipt up to 1.9 times as tall as wide, two up to 3.0, three above; 15 % overlap. */
  tiles(overlap?: number): Tile[];
}

export function encodeJpeg(r: Rgba, quality = 92): Uint8Array {
  return jpeg.encode({ data: r.data, width: r.width, height: r.height }, quality).data;
}

export function prepImage(image: ReceiptImage, opts: PrepOptions = {}): Prepared {
  const raster = decodeImage(image) as Raster | null;
  if (!raster) throw new Error(`cannot decode ${image.mediaType} for preparation`);
  const orig: Rgba = { width: raster.width, height: raster.height, data: new Uint8Array(raster.data) };
  const margin = opts.margin ?? 0.03;
  const scale = opts.scale ?? 2;

  const paper = findPaper(orig);
  const mx = Math.round((paper.x1 - paper.x0) * margin);
  const my = Math.round((paper.y1 - paper.y0) * margin);
  const c1 = { x0: Math.max(0, paper.x0 - mx), y0: Math.max(0, paper.y0 - my), x1: Math.min(orig.width, paper.x1 + mx), y1: Math.min(orig.height, paper.y1 + my) };
  let cur = crop(orig, c1.x0, c1.y0, c1.x1, c1.y1);

  const tilt = opts.deskew === false ? 0 : estimateTilt(cur);
  // Back to the original photo: undo the second crop, the rotation and the first crop.
  let toCrop1 = (x: number, y: number): [number, number] => [x, y];
  if (Math.abs(tilt) >= 0.3) {
    const before = cur;
    const rot = rotate(before, -tilt); // turn the paper back against its tilt
    const p2 = findPaper(rot.img);
    const mx2 = Math.round((p2.x1 - p2.x0) * margin);
    const my2 = Math.round((p2.y1 - p2.y0) * margin);
    const c2 = { x0: Math.max(0, p2.x0 - mx2), y0: Math.max(0, p2.y0 - my2), x1: Math.min(rot.img.width, p2.x1 + mx2), y1: Math.min(rot.img.height, p2.y1 + my2) };
    cur = crop(rot.img, c2.x0, c2.y0, c2.x1, c2.y1);
    const t = (-tilt * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    toCrop1 = (x, y) => {
      const rx = x + c2.x0 - rot.img.width / 2;
      const ry = y + c2.y0 - rot.img.height / 2;
      return [rx * cos + ry * sin + before.width / 2, -rx * sin + ry * cos + before.height / 2];
    };
  }
  const prepared = enlarge(cur, scale);

  const mapPoint = (px: number, py: number): [number, number] => {
    const [x, y] = toCrop1(px / scale, py / scale);
    return [(x + c1.x0) / orig.width, (y + c1.y0) / orig.height];
  };
  const mapBox = (b: Box, w: number, h: number, yOffset = 0): Box => {
    const corners = [
      [b.x * w, b.y * h + yOffset],
      [(b.x + b.w) * w, b.y * h + yOffset],
      [b.x * w, (b.y + b.h) * h + yOffset],
      [(b.x + b.w) * w, (b.y + b.h) * h + yOffset],
    ].map(([x, y]) => mapPoint(x, y));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const x0 = clamp(Math.min(...xs));
    const y0 = clamp(Math.min(...ys));
    return { x: x0, y: y0, w: clamp(Math.max(...xs)) - x0, h: clamp(Math.max(...ys)) - y0 };
  };

  return {
    image: prepared,
    tiltDeg: tilt,
    toOriginal: (b) => mapBox(b, prepared.width, prepared.height),
    png: () => PNG.sync.write(Object.assign(new PNG({ width: prepared.width, height: prepared.height }), { data: Buffer.from(prepared.data) })),
    tiles(overlap = 0.15) {
      const ratio = prepared.height / prepared.width;
      const n = ratio > 3.0 ? 3 : ratio > 1.9 ? 2 : 1;
      const tileH = Math.round(prepared.height / (n - (n - 1) * overlap));
      return Array.from({ length: n }, (_, i) => {
        const y0 = n === 1 ? 0 : Math.round(((prepared.height - tileH) * i) / (n - 1));
        const y1 = Math.min(prepared.height, y0 + tileH);
        return {
          bytes: encodeJpeg(crop(prepared, 0, y0, prepared.width, y1)),
          mediaType: "image/jpeg" as const,
          y0,
          y1,
          toOriginal: (b: Box) => mapBox(b, prepared.width, y1 - y0, y0),
        };
      });
    },
  };
}
