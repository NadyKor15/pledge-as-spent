// A phone writes a JPEG in the sensor's orientation and records how to turn it in the EXIF Orientation tag. jpeg-js
// ignores the tag, so the slicer, the closer and the published copy would see the photo on its side. This turns the
// pixels upright once, at the start of reading, so every step after it (the readers, the bands, the closed copy) works
// on the same upright pixels. Pure JS, no native code.

import jpeg from "jpeg-js";
import type { ReceiptImage } from "./types";

/** The EXIF Orientation of a JPEG (1..8), or 1 when it has none or it cannot be read. */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return 1;
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // image data: no EXIF before it
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2 || p + 2 + len > bytes.length) return 1;
    if (marker === 0xe1 && len >= 16 && String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === "Exif") {
      const t = p + 10; // TIFF header
      const little = bytes[t] === 0x49 && bytes[t + 1] === 0x49;
      const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const u32 = (o: number) => (little ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > p + 2 + len) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > p + 2 + len) return 1;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

/**
 * The photo upright: a JPEG with an Orientation other than 1 is decoded, turned or mirrored as the tag says, and
 * encoded again without the tag. Anything else comes back unchanged (the same object).
 */
export function uprightImage(image: ReceiptImage): ReceiptImage {
  if (image.mediaType !== "image/jpeg") return image;
  const o = exifOrientation(image.bytes);
  if (o === 1) return image;
  const src = jpeg.decode(image.bytes, { useTArray: true, formatAsRGBA: true });
  const { width: w, height: h } = src;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Where source pixel (x, y) lands in the upright image (EXIF orientations 2..8).
      let X = x;
      let Y = y;
      if (o === 2) X = w - 1 - x;
      else if (o === 3) {
        X = w - 1 - x;
        Y = h - 1 - y;
      } else if (o === 4) Y = h - 1 - y;
      else if (o === 5) {
        X = y;
        Y = x;
      } else if (o === 6) {
        X = h - 1 - y;
        Y = x;
      } else if (o === 7) {
        X = h - 1 - y;
        Y = w - 1 - x;
      } else if (o === 8) {
        X = y;
        Y = w - 1 - x;
      }
      const s = (y * w + x) * 4;
      const d = (Y * W + X) * 4;
      out[d] = src.data[s];
      out[d + 1] = src.data[s + 1];
      out[d + 2] = src.data[s + 2];
      out[d + 3] = 255;
    }
  return { bytes: jpeg.encode({ data: out, width: W, height: H }, 92).data, mediaType: "image/jpeg" };
}
