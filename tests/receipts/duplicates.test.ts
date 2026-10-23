import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { DHASH_MAX_DISTANCE, findDuplicate, fingerprint, type KnownReceipt } from "../../src/receipts/checks";
import { dHash, hammingHex, semanticKey, sha256Hex } from "../../src/receipts/hash";
import type { ReceiptImage } from "../../src/receipts/types";
import { receipt } from "./fixtures";

function raster(w: number, h: number, f: (x: number, y: number) => number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = f(x, y);
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}
const png = (bytes: Buffer): ReceiptImage => ({ bytes, mediaType: "image/png" });
// A smooth picture with clear light and dark regions, so no grid cell sits on a tie.
const page = (x: number, y: number) => Math.round(128 + 100 * Math.sin(x / 23) * Math.cos(y / 17));

describe("hashes", () => {
  it("sha256 is the standard digest", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("dHash is stable, survives light noise and recompression, and differs for another picture", () => {
    const a = dHash(png(raster(180, 160, page)))!;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(dHash(png(raster(180, 160, page)))).toBe(a);
    const noisy = dHash(png(raster(180, 160, (x, y) => Math.max(0, Math.min(255, page(x, y) + ((x * 31 + y * 17) % 9) - 4)))))!;
    expect(hammingHex(a, noisy)).toBeLessThanOrEqual(DHASH_MAX_DISTANCE);
    const raw = PNG.sync.read(raster(180, 160, page));
    const jpg = jpeg.encode({ data: raw.data, width: 180, height: 160 }, 80).data;
    expect(hammingHex(a, dHash({ bytes: jpg, mediaType: "image/jpeg" })!)).toBeLessThanOrEqual(DHASH_MAX_DISTANCE);
    const other = dHash(png(raster(180, 160, (x, y) => Math.round(128 + 100 * Math.cos(x / 9) * Math.sin(y / 31)))))!;
    expect(hammingHex(a, other)).toBeGreaterThan(DHASH_MAX_DISTANCE);
  });

  it("returns null for webp and rejects tiny images", () => {
    expect(dHash({ bytes: new Uint8Array(10), mediaType: "image/webp" })).toBeNull();
    expect(() => dHash(png(raster(4, 4, () => 0)))).toThrow(/too small/);
  });

  it("hammingHex counts differing bits", () => {
    expect(hammingHex("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingHex("00000000000000f0", "000000000000000f")).toBe(8);
  });

  it("semantic key ignores spacing, case and width of the store name; needs a date", () => {
    const a = semanticKey(receipt({ merchantName: "ミナト 生活館  北空店", totalMinor: 900 }));
    const b = semanticKey(receipt({ merchantName: "ﾐﾅﾄ生活館北空店", totalMinor: 900 }));
    expect(a).toBe(b);
    expect(semanticKey(receipt({ merchantName: "Shop A", totalMinor: 900 }))).toBe(semanticKey(receipt({ merchantName: "SHOP  a", totalMinor: 900 })));
    expect(semanticKey(receipt({ merchantName: "Shop A", totalMinor: 901 }))).not.toBe(semanticKey(receipt({ merchantName: "Shop A", totalMinor: 900 })));
    expect(semanticKey(receipt({ purchasedAt: "2026-11-05T14:33:10" }))).not.toBe(semanticKey(receipt({ purchasedAt: "2026-11-05T14:32:00" })));
    expect(semanticKey(receipt({ purchasedAt: null }))).toBeNull();
  });
});

describe("findDuplicate", () => {
  const img = png(raster(180, 160, page));
  const r = receipt();
  const fp = fingerprint(img, r);
  const known = (over: Partial<KnownReceipt>): KnownReceipt => ({ receiptId: "old", uploadedAt: "2026-11-05T10:00:00Z", sha256: "x", dHash: null, semanticKey: null, ...over });

  it("matches identical bytes", () => {
    expect(findDuplicate(fp, [known({ sha256: fp.sha256 })])?.kind).toBe("sha256");
  });
  it("matches the same store, minute and total", () => {
    expect(findDuplicate(fp, [known({ semanticKey: fp.semanticKey })])?.kind).toBe("semantic");
  });
  it("matches a near-identical picture", () => {
    expect(findDuplicate(fp, [known({ dHash: fp.dHash })])?.kind).toBe("phash");
  });
  it("matches nothing unrelated, and never on a missing key", () => {
    const nokeys = { ...fp, dHash: null, semanticKey: null };
    expect(findDuplicate(nokeys, [known({})])).toBeNull();
    expect(findDuplicate(fp, [known({ dHash: "ffffffffffffffff", semanticKey: "other|2026|1" })])).toBeNull();
  });
  it("prefers the strongest key and then the earliest upload", () => {
    const hit = findDuplicate(fp, [
      known({ receiptId: "b", uploadedAt: "2026-11-06T00:00:00Z", semanticKey: fp.semanticKey }),
      known({ receiptId: "a", uploadedAt: "2026-11-05T00:00:00Z", semanticKey: fp.semanticKey }),
      known({ receiptId: "c", uploadedAt: "2026-11-07T00:00:00Z", sha256: fp.sha256 }),
    ]);
    expect(hit?.kind).toBe("sha256");
    expect(hit?.of.receiptId).toBe("c");
    expect(findDuplicate(fp, [known({ receiptId: "b", uploadedAt: "2026-11-06T00:00:00Z", semanticKey: fp.semanticKey }), known({ receiptId: "a", uploadedAt: "2026-11-05T00:00:00Z", semanticKey: fp.semanticKey })])?.of.receiptId).toBe("a");
  });
  it("respects the distance limit", () => {
    const near = (fp.dHash as string).slice(0, 15) + ((parseInt((fp.dHash as string)[15], 16) ^ 1).toString(16));
    expect(findDuplicate(fp, [known({ dHash: near })], 0)).toBeNull();
    expect(findDuplicate(fp, [known({ dHash: near })], 1)?.kind).toBe("phash");
  });
});
