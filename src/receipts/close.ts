// Closing a receipt photo: everything printed goes, except the purchase lines. Nothing personal is looked for: a
// card number, a member number, a cashier or a customer's name is simply not a purchase line, so it is closed like
// the store's header, the totals, the payment block and the barcodes. Only the pixels inside the bands that the
// reading tied to a purchase line stay as printed; the rest of the photo becomes a smooth background with the light
// of the original paper and desk and no print on it. No band, no line tied to a band: the whole photo is closed.
// The approach is ported from the author's own BillRadar closing (started October 26, 2026), rewritten in TypeScript
// for receipts: one band per printed row across the whole paper instead of table cells. Pure JS, no native modules.

import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { Band, PurchaseLine, ReceiptImage } from "./types";

type Point = readonly [number, number];

/**
 * Band: one printed row of the receipt (src/receipts/slice.ts). `quad` is the row on the ORIGINAL photo, in its pixels,
 * corners clockwise from top left (a tilted photo makes it a slanted strip); `y0`/`y1` belong to the reader's
 * straightened paper and are not used here. PurchaseLine: a purchase line and the bands it is printed on.
 */
export type { Band, PurchaseLine };

export interface CloseOptions {
  /** JPEG quality of a closed JPEG, 1..100. */
  jpegQuality?: number;
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

/** Written into every closed copy (a PNG text chunk, a JPEG comment): only a copy that carries it is ever served. */
export const CLOSED_MARK = "pledge-as-spent: closed, only purchase lines open, v1";
const PNG_KEYWORD = "Comment";

/** A band taller than this many times the receipt's usual band holds more than one row: it stays closed. */
const TALL = 2.5;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The four corners as numbers, or null: anything else cannot be drawn, so it opens nothing. */
function corners(b: Band): Point[] | null {
  if (!Array.isArray(b.quad) || b.quad.length !== 4) return null;
  const pts = b.quad.map((p) => (Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]) ? ([p[0], p[1]] as Point) : null));
  if (pts.some((p) => p === null)) return null;
  const q = pts as Point[];
  let area = 0;
  for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  return Math.abs(area) / 2 >= 1 ? q : null;
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Height of a band on the photo: its left and right sides, averaged. */
const heightOf = (q: Point[]) => (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface OpenPlan {
  /** Bands that stay as printed. */
  open: Band[];
  /** Every purchase line: open when all of its bands are open, else closed with the reason. */
  lines: { lineNo: number; open: boolean; why: string | null }[];
}

/**
 * Which bands open. A band opens only when a purchase line names it, its corners can be drawn, its index is given
 * once, and it is not taller than a row should be (a taller band may hold the row next to it). A line opens only when
 * every band it names opens: half a line would show a name without its amount, or an amount without its name.
 */
export function openPlan(bands: readonly Band[], purchaseLines: readonly PurchaseLine[]): OpenPlan {
  const byIndex = new Map<number, Point[]>();
  const twice = new Set<number>();
  for (const b of bands) {
    const q = b && Number.isSafeInteger(b.index) ? corners(b) : null;
    if (!q) continue;
    if (byIndex.has(b.index)) twice.add(b.index);
    byIndex.set(b.index, q);
  }
  const tall = TALL * median([...byIndex.values()].map(heightOf));
  const lines: OpenPlan["lines"] = [];
  const open = new Set<number>();
  for (const l of purchaseLines) {
    const idx = [...new Set(Array.isArray(l?.bandIndexes) ? l.bandIndexes : [])];
    let why: string | null = null;
    if (!idx.length) why = "no band";
    for (const i of idx) {
      const q = byIndex.get(i);
      if (!q) why ??= `band ${i} is not on the photo`;
      else if (twice.has(i)) why ??= `band ${i} is given twice`;
      else if (heightOf(q) > tall) why ??= `band ${i} is taller than a row`;
    }
    lines.push({ lineNo: l?.lineNo, open: why === null, why });
    if (why === null) for (const i of idx) open.add(i);
  }
  return { open: bands.filter((b) => open.has(b.index) && byIndex.has(b.index)), lines };
}

/**
 * Pixels of a polygon, by their centres: a pixel belongs to it when (x + 0.5, y + 0.5) lies inside (even-odd rule,
 * half-open across, so two bands that share an edge never both take a pixel on it).
 */
function eachPixel(width: number, height: number, poly: Point[], at: (p: number) => void): void {
  const ys = poly.map((p) => p[1]);
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const xs: number[] = [];
  for (let y = top; y <= bottom; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      if ((ay <= yc) === (by <= yc)) continue;
      xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width, Math.ceil(xs[k + 1] - 0.5));
      for (let x = from; x < to; x++) at(y * width + x);
    }
  }
}

function fillPolygon(mask: Uint8Array, width: number, height: number, poly: Point[], value: number): void {
  eachPixel(width, height, poly, (p) => (mask[p] = value));
}

const lum = (d: Uint8Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Print, for the seams: a pixel darker than this (luminance 0..255). The closing measure counts print the same way. */
export const PRINT_LUM = 120;

/** A gap between two open bands taller than this share of the receipt's usual band could hold a row of its own. */
const SEAM = 1 / 3;

/**
 * A band that lies as a row does: corners clockwise from top left, its top and bottom edges running left to right and
 * more across than down, the bottom below the top. Only between two such bands is "the gap between them" well drawn.
 */
function lying(q: Point[]): boolean {
  const [tl, tr, br, bl] = q;
  const across = (a: Point, b: Point) => b[0] > a[0] && Math.abs(b[1] - a[1]) <= b[0] - a[0];
  return across(tl, tr) && across(bl, br) && bl[1] > tl[1] && br[1] > tr[1];
}

/** y of the edge a→b at x (the edge runs left to right). */
const edgeY = (a: Point, b: Point, x: number) => a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);

/**
 * The seam between two open bands that follow each other (`upper` then `lower`), or null when it must stay closed.
 * The seam is every pixel whose centre lies between the upper band's bottom edge and the lower band's top edge, across
 * only where both edges run, and inside no band. It opens whole or not at all: null when the two do not lie as rows,
 * when the gap is taller than a third of the receipt's usual band, when any other band reaches into it, or when any
 * of its pixels is print. An empty list: the two bands touch or overlap, there is nothing between them.
 */
function seam(photo: Raster, owner: Int32Array, upper: { q: Point[]; at: number }, lower: { q: Point[]; at: number }, usual: number): number[] | null {
  if (!lying(upper.q) || !lying(lower.q)) return null;
  const [, , br, bl] = upper.q;
  const [tl, tr] = lower.q;
  const xa = Math.max(bl[0], tl[0]);
  const xb = Math.min(br[0], tr[0]);
  if (!(xb > xa)) return [];
  const gap = (x: number) => edgeY(tl, tr, x) - edgeY(bl, br, x);
  if (Math.max(gap(xa), gap(xb)) > SEAM * usual) return null;
  const { width: w, height: h, data } = photo;
  const out: number[] = [];
  for (let x = Math.max(0, Math.ceil(xa - 0.5)); x < Math.min(w, Math.ceil(xb - 0.5)); x++) {
    const xc = x + 0.5;
    const from = Math.max(0, Math.ceil(edgeY(bl, br, xc) - 0.5));
    const to = Math.min(h, Math.ceil(edgeY(tl, tr, xc) - 0.5));
    for (let y = from; y < to; y++) {
      const p = y * w + x;
      const o = owner[p];
      if (o === upper.at || o === lower.at) continue; // the pair's own pixel, open already
      if (o !== 0) return null; // another band, or two
      if (lum(data, p * 4) < PRINT_LUM) return null;
      out.push(p);
    }
  }
  return out;
}

/**
 * 1 where the photo stays as printed: inside an open band and inside no other band. Where a closed band and an open
 * one overlap, the closed one wins.
 *
 * With the photo, also the seams: the hairline of paper the reader's bands leave between two rows. A seam opens only
 * between two OPEN bands that follow each other (index k and k + 1: rows of one purchase line, or the last row of a
 * line and the first of the next), only across where both bands run, and only when no pixel of it is print; then it
 * shows plain paper that sits between two rows already shown. Next to a closed band, nothing beyond the open bands
 * opens. Without the photo, only the bands: nothing that has not been looked at opens.
 */
export function openMask(width: number, height: number, bands: readonly Band[], purchaseLines: readonly PurchaseLine[], photo?: Raster): Uint8Array {
  const mask = new Uint8Array(width * height);
  const plan = openPlan(bands, purchaseLines);
  const open = new Set(plan.open.map((b) => b.index));
  for (const b of plan.open) fillPolygon(mask, width, height, corners(b)!, 1);
  if (photo && photo.width === width && photo.height === height && plan.open.length > 1) {
    // Which band each pixel belongs to: its place in `bands` + 1, 0 for none, -1 for more than one.
    const owner = new Int32Array(width * height);
    const drawn: { b: Band; q: Point[]; at: number }[] = [];
    bands.forEach((b, i) => {
      const q = b ? corners(b) : null;
      if (!q) return;
      drawn.push({ b, q, at: i + 1 });
      eachPixel(width, height, q, (p) => (owner[p] = owner[p] === 0 ? i + 1 : -1));
    });
    const usual = median(drawn.map((d) => heightOf(d.q)));
    const byIndex = new Map(drawn.filter((d) => open.has(d.b.index)).map((d) => [d.b.index, d]));
    for (const [k, upper] of byIndex) {
      const lower = byIndex.get(k + 1);
      if (!lower) continue;
      for (const p of seam(photo, owner, upper, lower, usual) ?? []) mask[p] = 1;
    }
  }
  for (const b of bands) {
    if (!b || open.has(b.index)) continue;
    const q = corners(b);
    if (q) fillPolygon(mask, width, height, q, 0);
  }
  return mask;
}

/**
 * The photo without print: in cells much larger than a letter, the colour of the brightest part of each cell (paper
 * between the letters, or the desk), cleaned of odd cells by a median, softened, then spread back smoothly. A cell
 * is too coarse to hold a letter, a digit or a bar of a barcode; it keeps only the light across the paper and desk.
 */
export function smoothBackground(img: Raster): Uint8Array {
  const { width: w, height: h, data } = img;
  const cell = Math.max(16, Math.round(Math.min(w, h) / 20));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const grid = new Float64Array(cw * ch * 3);
  const step = Math.max(1, Math.floor(cell / 32));
  const vals: number[] = [];
  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      vals.length = 0;
      const x0 = gx * cell;
      const y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) vals.push(lum(data, (y * w + x) * 4));
      const cut = [...vals].sort((a, b) => a - b)[Math.floor(0.85 * (vals.length - 1))];
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += step)
        for (let x = x0; x < x1; x += step) {
          const i = (y * w + x) * 4;
          if (lum(data, i) < cut) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      const o = (gy * cw + gx) * 3;
      grid[o] = r / n;
      grid[o + 1] = g / n;
      grid[o + 2] = b / n;
    }
  }
  // A cell that is all barcode or all bold type does not survive its neighbours.
  const med = new Float64Array(grid.length);
  const near: number[] = [];
  for (let gy = 0; gy < ch; gy++)
    for (let gx = 0; gx < cw; gx++) {
      near.length = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < cw && y < ch) near.push((y * cw + x) * 3);
        }
      near.sort((a, b) => grid[a] * 0.299 + grid[a + 1] * 0.587 + grid[a + 2] * 0.114 - (grid[b] * 0.299 + grid[b + 1] * 0.587 + grid[b + 2] * 0.114));
      const m = near[Math.floor(near.length / 2)];
      const o = (gy * cw + gx) * 3;
      med[o] = grid[m];
      med[o + 1] = grid[m + 1];
      med[o + 2] = grid[m + 2];
    }
  const soft = new Float64Array(grid.length);
  for (let gy = 0; gy < ch; gy++)
    for (let gx = 0; gx < cw; gx++) {
      let n = 0;
      const o = (gy * cw + gx) * 3;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
          const p = (y * cw + x) * 3;
          soft[o] += med[p];
          soft[o + 1] += med[p + 1];
          soft[o + 2] += med[p + 2];
          n++;
        }
      soft[o] /= n;
      soft[o + 1] /= n;
      soft[o + 2] /= n;
    }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(ch - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(cw - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = soft[(y0 * cw + x0) * 3 + c] * (1 - tx) + soft[(y0 * cw + x1) * 3 + c] * tx;
        const b = soft[(y1 * cw + x0) * 3 + c] * (1 - tx) + soft[(y1 * cw + x1) * 3 + c] * tx;
        out[o + c] = Math.round(a * (1 - ty) + b * ty);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The closed raster: the original inside the open mask, the smooth background everywhere else. Same size. */
export function closeRaster(img: Raster, bands: readonly Band[], purchaseLines: readonly PurchaseLine[]): Raster {
  const mask = openMask(img.width, img.height, bands, purchaseLines, img);
  const out = smoothBackground(img);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    out[i] = img.data[i];
    out[i + 1] = img.data[i + 1];
    out[i + 2] = img.data[i + 2];
    out[i + 3] = img.data[i + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

type Format = "image/png" | "image/jpeg";

export function formatOf(bytes: Uint8Array): Format | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export function decodeRaster(bytes: Uint8Array): Raster {
  const format = formatOf(bytes);
  if (format === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (format === "image/jpeg") {
    const j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: j.width, height: j.height, data: j.data };
  }
  throw new Error("Only PNG and JPEG photos can be closed.");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A tEXt chunk with the mark, right after IHDR (8-byte signature + 25-byte IHDR). */
function markPng(png: Buffer): Buffer {
  const body = Buffer.from(`tEXt${PNG_KEYWORD}\0${CLOSED_MARK}`, "latin1");
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

/** A COM segment with the mark, after the JFIF APP0 segment when there is one (it must follow SOI). */
function markJpeg(jpg: Buffer): Buffer {
  const text = Buffer.from(CLOSED_MARK, "latin1");
  const seg = Buffer.alloc(text.length + 4);
  seg[0] = 0xff;
  seg[1] = 0xfe;
  seg.writeUInt16BE(text.length + 2, 2);
  text.copy(seg, 4);
  const at = jpg[2] === 0xff && jpg[3] === 0xe0 ? 4 + jpg.readUInt16BE(4) : 2;
  return Buffer.concat([jpg.subarray(0, at), seg, jpg.subarray(at)]);
}

export function encodeRaster(img: Raster, format: Format, opts: CloseOptions = {}): Buffer {
  if (format === "image/png") {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return markPng(PNG.sync.write(png));
  }
  const q = Math.min(100, Math.max(1, Math.round(opts.jpegQuality ?? 90)));
  return markJpeg(Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, q).data));
}

/** True only for bytes that closeReceipt wrote: a PNG or JPEG that carries the mark before its image data. */
export function isClosedCopy(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = formatOf(b);
  if (format === "image/png") {
    for (let at = 8; at + 12 <= b.length; ) {
      const len = b.readUInt32BE(at);
      const type = b.toString("latin1", at + 4, at + 8);
      if (type === "IDAT" || type === "IEND") return false;
      if (type === "tEXt" && b.toString("latin1", at + 8, at + 8 + len) === `${PNG_KEYWORD}\0${CLOSED_MARK}`) return true;
      at += 12 + len;
    }
    return false;
  }
  if (format === "image/jpeg") {
    for (let at = 2; at + 4 <= b.length; ) {
      if (b[at] !== 0xff) return false;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return false;
      const len = b.readUInt16BE(at + 2);
      if (marker === 0xfe && b.toString("latin1", at + 4, at + 2 + len) === CLOSED_MARK) return true;
      at += 2 + len;
    }
  }
  return false;
}

/** The photo's bytes closed by the bands, everything closed when no line opens; throws on a photo it cannot decode. */
export function closeBytes(image: Uint8Array, bands: readonly Band[], purchaseLines: readonly PurchaseLine[], opts: CloseOptions = {}): Buffer {
  const format = formatOf(image);
  if (!format) throw new Error("Only PNG and JPEG photos can be closed.");
  return encodeRaster(closeRaster(decodeRaster(image), bands, purchaseLines), format, opts);
}

/**
 * The receipt photo with only its purchase lines open: same size and media type (PNG stays PNG, JPEG stays JPEG, no
 * EXIF or other metadata carried over), the mark written in. null when there is nothing to publish: no purchase line
 * could be opened (no bands, no line tied to a band, or every line's bands refused by openPlan), or the photo is not
 * the PNG or JPEG it says it is, or cannot be decoded. Closed by default: null means no copy at all, never the
 * original.
 */
export function closeReceipt(image: ReceiptImage, bands: Band[], purchaseLines: PurchaseLine[], opts: CloseOptions = {}): Uint8Array | null {
  if (formatOf(image.bytes) !== image.mediaType) return null;
  if (!openPlan(bands, purchaseLines).lines.some((l) => l.open)) return null;
  try {
    return new Uint8Array(closeBytes(image.bytes, bands, purchaseLines, opts));
  } catch {
    return null;
  }
}
