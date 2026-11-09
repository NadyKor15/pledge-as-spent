import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { exifOrientation, uprightImage } from "../../src/receipts/orient";

// A phone photo is stored on its side with an EXIF Orientation tag; the slicer, the closer and the readers must all see
// it upright, so it is turned once, before any of them.

/** A 3x2 JPEG, left column black and the rest white, with an EXIF APP1 carrying `orientation` (big-endian TIFF). */
function photo(orientation: number | null): Uint8Array {
  const w = 30;
  const h = 20;
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  const plain = jpeg.encode({ data, width: w, height: h }, 95).data;
  if (orientation === null) return plain;
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  return new Uint8Array([plain[0], plain[1], ...app1, ...plain.subarray(2)]);
}

const darkAt = (img: { bytes: Uint8Array }, fx: number, fy: number) => {
  const d = jpeg.decode(img.bytes, { useTArray: true });
  const x = Math.floor(fx * d.width);
  const y = Math.floor(fy * d.height);
  return d.data[(y * d.width + x) * 4] < 128;
};

describe("uprightImage", () => {
  it("reads the Orientation tag, and 1 when there is none", () => {
    expect(exifOrientation(photo(6))).toBe(6);
    expect(exifOrientation(photo(null))).toBe(1);
    expect(exifOrientation(new Uint8Array([1, 2, 3]))).toBe(1);
  });

  it("turns a photo tagged 6 a quarter turn clockwise: the left column becomes the top row", () => {
    const up = uprightImage({ bytes: photo(6), mediaType: "image/jpeg" });
    const d = jpeg.decode(up.bytes, { useTArray: true });
    expect([d.width, d.height]).toEqual([20, 30]);
    expect(darkAt(up, 0.5, 0.1)).toBe(true);
    expect(darkAt(up, 0.5, 0.9)).toBe(false);
    expect(exifOrientation(up.bytes)).toBe(1);
  });

  it("turns 3 half round and 8 a quarter turn the other way", () => {
    const half = uprightImage({ bytes: photo(3), mediaType: "image/jpeg" });
    expect(darkAt(half, 0.9, 0.5)).toBe(true);
    const ccw = uprightImage({ bytes: photo(8), mediaType: "image/jpeg" });
    expect(darkAt(ccw, 0.5, 0.9)).toBe(true);
  });

  it("leaves an upright JPEG and a PNG as they are", () => {
    const j = { bytes: photo(null), mediaType: "image/jpeg" as const };
    expect(uprightImage(j)).toBe(j);
    const p = { bytes: new Uint8Array([0x89, 0x50]), mediaType: "image/png" as const };
    expect(uprightImage(p)).toBe(p);
  });
});
