import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ParsedReceipt, ReceiptImage } from "../receipts/types";

// Blurs the personal data the reader located (pii[].bbox, fractions of the
// image) so only the blurred copy is ever published. Pure JS, no native modules.

export interface Redaction {
  /** The publishable copy; null when something could not be blurred. */
  bytes: Uint8Array | null;
  regions: number;
  note: string | null;
}

export const NOT_BLURRED_NOTE = "Personal data was found but could not be blurred, so this image is not published.";

interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Three box-blur passes (close to a Gaussian) over one rectangle, horizontal then vertical. */
function blurRect(img: Raster, x0: number, y0: number, x1: number, y1: number, radius: number): void {
  const { width, data } = img;
  const w = x1 - x0;
  const h = y1 - y0;
  const line = new Float64Array(Math.max(w, h) * 4);
  const pass = (count: number, len: number, at: (i: number, k: number) => number) => {
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < len; k++) for (let c = 0; c < 4; c++) line[k * 4 + c] = data[at(i, k) + c];
      for (let k = 0; k < len; k++) {
        const lo = Math.max(0, k - radius);
        const hi = Math.min(len - 1, k + radius);
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let j = lo; j <= hi; j++) sum += line[j * 4 + c];
          data[at(i, k) + c] = Math.round(sum / (hi - lo + 1));
        }
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(h, w, (row, k) => ((y0 + row) * width + x0 + k) * 4);
    pass(w, h, (col, k) => ((y0 + k) * width + x0 + col) * 4);
  }
}

function decode(image: ReceiptImage): Raster | null {
  if (image.mediaType === "image/png") {
    const png = PNG.sync.read(Buffer.from(image.bytes));
    return { width: png.width, height: png.height, data: png.data };
  }
  if (image.mediaType === "image/jpeg") {
    const j = jpeg.decode(image.bytes, { useTArray: true, formatAsRGBA: true });
    return { width: j.width, height: j.height, data: j.data };
  }
  return null;
}

function encode(img: Raster, mediaType: ReceiptImage["mediaType"]): Uint8Array {
  if (mediaType === "image/png") {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return new Uint8Array(PNG.sync.write(png));
  }
  return new Uint8Array(jpeg.encode({ width: img.width, height: img.height, data: img.data }, 85).data);
}

export function redactImage(image: ReceiptImage, pii: ParsedReceipt["pii"]): Redaction {
  if (pii.length === 0) return { bytes: image.bytes, regions: 0, note: null };
  if (pii.some((p) => !p.bbox)) return { bytes: null, regions: 0, note: NOT_BLURRED_NOTE };
  const img = decode(image);
  if (!img) return { bytes: null, regions: 0, note: NOT_BLURRED_NOTE };
  for (const p of pii) {
    const b = p.bbox!;
    // A margin around the box: readers place boxes tightly, sometimes a little off.
    const mx = Math.max(4, b.h * img.height * 0.5);
    const my = Math.max(4, b.h * img.height * 0.5);
    const x0 = Math.max(0, Math.floor(b.x * img.width - mx));
    const y0 = Math.max(0, Math.floor(b.y * img.height - my));
    const x1 = Math.min(img.width, Math.ceil((b.x + b.w) * img.width + mx));
    const y1 = Math.min(img.height, Math.ceil((b.y + b.h) * img.height + my));
    if (x1 - x0 < 2 || y1 - y0 < 2) return { bytes: null, regions: 0, note: NOT_BLURRED_NOTE };
    blurRect(img, x0, y0, x1, y1, Math.max(8, Math.ceil((y1 - y0) / 2)));
  }
  return { bytes: encode(img, image.mediaType), regions: pii.length, note: null };
}
