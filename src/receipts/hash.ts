import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { ParsedReceipt, ReceiptImage } from "./types";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const cols = 17;
const rows = 16;

type Raster = { width: number; height: number; data: Uint8Array | Buffer };

function decode(image: ReceiptImage): Raster | null {
  if (image.mediaType === "image/png") return PNG.sync.read(Buffer.from(image.bytes));
  if (image.mediaType === "image/jpeg") return jpeg.decode(image.bytes, { useTArray: true });
  return null; // webp: no pure-JS decoder here
}

/**
 * 256-bit difference hash (17x16 grey grid, left cell brighter than right), hex.
 * Returns null for formats we cannot decode; the caller then relies on the other keys.
 */
export function dHash(image: ReceiptImage): string | null {
  const raster = decode(image);
  if (!raster) return null;
  const { width, height, data } = raster;
  if (width < cols || height < rows) throw new Error(`image too small for dHash: ${width}x${height}`);
  const sum = new Float64Array(cols * rows);
  const count = new Float64Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / width));
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      // Composite on white so transparent pixels do not read as black.
      const grey = 0.299 * (data[i] * a + 255 * (1 - a)) + 0.587 * (data[i + 1] * a + 255 * (1 - a)) + 0.114 * (data[i + 2] * a + 255 * (1 - a));
      sum[cy * cols + cx] += grey;
      count[cy * cols + cx] += 1;
    }
  }
  let bits = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const left = sum[y * cols + x] / count[y * cols + x];
      const right = sum[y * cols + x + 1] / count[y * cols + x + 1];
      bits += left > right ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingHex(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    let x = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Same store, same minute, same total: the receipt, however it was photographed. Needs a date and a time
 * (a date alone would block a second receipt of the same day), accepts `T` or a space between them and
 * ignores seconds, and needs a store name that was actually read. Null otherwise.
 */
export function semanticKey(r: Pick<ParsedReceipt, "merchantName" | "purchasedAt" | "totalMinor">): string | null {
  const m = r.purchasedAt?.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  const store = fold(r.merchantName);
  if (!m || !store) return null;
  return `${store}|${m[1]}T${m[2]}:${m[3]}|${r.totalMinor}`;
}
