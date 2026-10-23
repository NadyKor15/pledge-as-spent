import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { ParsedReceipt, ReceiptImage } from "./types";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Raster = { width: number; height: number; data: Uint8Array | Buffer };

function decode(image: ReceiptImage): Raster | null {
  if (image.mediaType === "image/png") return PNG.sync.read(Buffer.from(image.bytes));
  if (image.mediaType === "image/jpeg") return jpeg.decode(image.bytes, { useTArray: true });
  return null; // webp: no pure-JS decoder here
}

/**
 * 64-bit difference hash (9x8 grey grid, left pixel brighter than right), hex.
 * Returns null for formats we cannot decode; the caller then relies on the other keys.
 */
export function dHash(image: ReceiptImage): string | null {
  const raster = decode(image);
  if (!raster) return null;
  const { width, height, data } = raster;
  if (width < 9 || height < 8) throw new Error(`image too small for dHash: ${width}x${height}`);
  const cols = 9;
  const rows = 8;
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
  let bits = 0n;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const left = sum[y * cols + x] / count[y * cols + x];
      const right = sum[y * cols + x + 1] / count[y * cols + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Same store, same minute, same total: the receipt, however it was photographed. Null when the date is unread. */
export function semanticKey(r: Pick<ParsedReceipt, "merchantName" | "purchasedAt" | "totalMinor">): string | null {
  if (!r.purchasedAt) return null;
  const minute = r.purchasedAt.slice(0, 16);
  return `${fold(r.merchantName)}|${minute}|${r.totalMinor}`;
}
