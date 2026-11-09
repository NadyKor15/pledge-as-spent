import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { closeBytes, closeReceipt, decodeRaster, formatOf, isClosedCopy, openMask, openPlan, smoothBackground, type Band, type PurchaseLine, type Raster } from "../../src/receipts/close";
import { HERO_PHOTO, heroClosing } from "../fixtures/closed-hero";

// A photo is closed to its purchase lines: inside the bands tied to a purchase line it stays as printed, everywhere
// else it becomes a smooth background with no print. Checked on drawn receipts (tilted rows of ink on paper on a
// desk) and on the sample receipt.

const W = 220;
const H = 180;
const SLOPE = 0.06; // the rows fall to the right, as on a tilted photo
const ROWS = [20, 50, 80, 110, 140]; // top of each row of type, at x = 10; each row is 10 px high
const PAPER: [number, number, number] = [238, 235, 226];
const INK: [number, number, number] = [35, 35, 40];
const DESK: [number, number, number] = [70, 74, 80];

const lum = (d: Uint8Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Paper from x 6 to 214 on a desk; five tilted rows of "type": every other pair of columns inked. */
function drawn(): Raster {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const onPaper = x >= 6 && x < 214;
      const yy = y - SLOPE * (x - 10);
      const inked = onPaper && x >= 14 && x < 206 && x % 4 < 2 && ROWS.some((t) => yy >= t && yy < t + 10);
      const c = !onPaper ? DESK : inked ? INK : PAPER;
      data.set([c[0], c[1], c[2], 255], i);
    }
  return { width: W, height: H, data };
}

/** Band k (1-based) around row k: 5 px of gap above and below, across the paper, tilted with the rows. */
function band(k: number, extra = 0): Band {
  const t = ROWS[k - 1];
  const y0 = t - 5;
  const y1 = t + 15 + extra;
  const at = (x: number, y: number): [number, number] => [x, y + SLOPE * (x - 10)];
  return { index: k, y0, y1, quad: [at(8, y0), at(212, y0), at(212, y1), at(8, y1)] };
}
const BANDS = [1, 2, 3, 4, 5].map((k) => band(k));

const png = (r: Raster) => {
  const p = new PNG({ width: r.width, height: r.height });
  p.data = Buffer.from(r.data);
  return new Uint8Array(PNG.sync.write(p));
};

/** Inked pixels of `img` inside band k's quad, by the same pixel rule as the closing. */
function inkIn(img: Raster, b: Band): number {
  const m = openMask(img.width, img.height, [b], [{ lineNo: 1, bandIndexes: [b.index] }]);
  let n = 0;
  for (let p = 0; p < m.length; p++) if (m[p] && lum(img.data, p * 4) < 100) n++;
  return n;
}

describe("closeReceipt on a drawn receipt", () => {
  const original = drawn();
  const bytes = png(original);
  const image = { bytes, mediaType: "image/png" as const };

  it("keeps the bands of the purchase lines as printed and closes every other row", () => {
    const out = decodeRaster(closeReceipt(image, BANDS, [{ lineNo: 1, bandIndexes: [2] }, { lineNo: 2, bandIndexes: [4] }])!);
    expect([out.width, out.height]).toEqual([W, H]);
    const open = openMask(W, H, BANDS, [{ lineNo: 1, bandIndexes: [2] }, { lineNo: 2, bandIndexes: [4] }]);
    let kept = 0;
    let openPx = 0;
    let inkOutside = 0;
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      if (open[p]) {
        openPx++;
        if (out.data[i] === original.data[i] && out.data[i + 1] === original.data[i + 1] && out.data[i + 2] === original.data[i + 2]) kept++;
      } else if (lum(out.data, i) < 100) inkOutside++;
    }
    expect(openPx).toBeGreaterThan(2 * 200 * 15);
    expect(kept).toBe(openPx);
    expect(inkOutside).toBe(0);
    for (const k of [1, 3, 5]) {
      expect(inkIn(original, band(k)), `row ${k} has ink to close`).toBeGreaterThan(300);
      expect(inkIn(out, band(k)), `row ${k}`).toBe(0);
    }
    for (const k of [2, 4]) expect(inkIn(out, band(k))).toBe(inkIn(original, band(k)));
  });

  it("with no bands, or no purchase line tied to a band, closes everything: nothing to publish", () => {
    const cases: [Band[], PurchaseLine[]][] = [
      [[], []],
      [BANDS, []],
      [[], [{ lineNo: 1, bandIndexes: [2] }]],
      [BANDS, [{ lineNo: 1, bandIndexes: [] }]],
      [BANDS, [{ lineNo: 1, bandIndexes: [2, 9] }]],
    ];
    for (const [bands, lines] of cases) {
      expect(closeReceipt(image, bands, lines)).toBeNull();
      const out = decodeRaster(closeBytes(bytes, bands, lines));
      let ink = 0;
      for (let p = 0; p < W * H; p++) if (lum(out.data, p * 4) < 100) ink++;
      expect(ink).toBe(0);
    }
  });

  it("writes a PNG of the same size with the mark; the original carries none", () => {
    const out = closeReceipt(image, BANDS, [{ lineNo: 1, bandIndexes: [1] }])!;
    expect(formatOf(out)).toBe("image/png");
    expect(isClosedCopy(out)).toBe(true);
    expect(isClosedCopy(bytes)).toBe(false);
    expect(Buffer.compare(Buffer.from(out), closeBytes(bytes, BANDS, [{ lineNo: 1, bandIndexes: [1] }]))).toBe(0);
  });

  it("keeps a JPEG a JPEG, with the mark, and carries no EXIF over", () => {
    const raw = Buffer.from(jpeg.encode({ width: W, height: H, data: original.data }, 92).data);
    const secret = Buffer.from("Exif\0\0GPS 28.5383 -81.3792 OWNER-NAME", "latin1");
    const app1 = Buffer.alloc(secret.length + 4);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1.writeUInt16BE(secret.length + 2, 2);
    secret.copy(app1, 4);
    const withExif = new Uint8Array(Buffer.concat([raw.subarray(0, 2), app1, raw.subarray(2)]));
    const out = Buffer.from(closeReceipt({ bytes: withExif, mediaType: "image/jpeg" }, BANDS, [{ lineNo: 1, bandIndexes: [3] }])!);
    expect(formatOf(out)).toBe("image/jpeg");
    expect(isClosedCopy(out)).toBe(true);
    expect(isClosedCopy(withExif)).toBe(false);
    expect(out.includes(Buffer.from("OWNER-NAME"))).toBe(false);
    expect(Buffer.from(withExif).includes(Buffer.from("OWNER-NAME"))).toBe(true);
    const back = decodeRaster(out);
    expect([back.width, back.height]).toEqual([W, H]);
    expect(inkIn(back, band(1))).toBe(0);
    expect(inkIn(back, band(3))).toBeGreaterThan(300);
  });

  it("no copy for what it cannot decode, or for bytes that are not the media type they claim", () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    expect(closeReceipt({ bytes: webp, mediaType: "image/webp" }, BANDS, [{ lineNo: 1, bandIndexes: [1] }])).toBeNull();
    expect(closeReceipt({ bytes, mediaType: "image/jpeg" }, BANDS, [{ lineNo: 1, bandIndexes: [1] }])).toBeNull();
    const broken = new Uint8Array(bytes.subarray(0, 60));
    expect(closeReceipt({ bytes: broken, mediaType: "image/png" }, BANDS, [{ lineNo: 1, bandIndexes: [1] }])).toBeNull();
    expect(() => closeBytes(new Uint8Array([1, 2, 3]), BANDS, [])).toThrow(/PNG and JPEG/);
  });
});

describe("which bands open", () => {
  it("a line opens only when every band it names opens", () => {
    const plan = openPlan(BANDS, [
      { lineNo: 1, bandIndexes: [1, 2] },
      { lineNo: 2, bandIndexes: [3, 9] },
      { lineNo: 3, bandIndexes: [] },
    ]);
    expect(plan.lines).toEqual([
      { lineNo: 1, open: true, why: null },
      { lineNo: 2, open: false, why: "band 9 is not on the photo" },
      { lineNo: 3, open: false, why: "no band" },
    ]);
    expect(plan.open.map((b) => b.index)).toEqual([1, 2]);
  });

  it("a band taller than a row, a band given twice, or one that cannot be drawn stays closed", () => {
    const tall = { ...band(5, 60) };
    const bad: Band = { index: 6, y0: 0, y1: 1, quad: [[1, 1], [2, 2], [Number.NaN, 3], [0, 4]] };
    const flat: Band = { index: 7, y0: 0, y1: 1, quad: [[1, 1], [50, 1], [100, 1], [0, 1]] };
    const plan = openPlan([...BANDS.slice(0, 4), tall, bad, flat, { ...band(1), index: 2 }], [
      { lineNo: 1, bandIndexes: [5] },
      { lineNo: 2, bandIndexes: [6] },
      { lineNo: 3, bandIndexes: [7] },
      { lineNo: 4, bandIndexes: [2] },
      { lineNo: 5, bandIndexes: [3] },
    ]);
    expect(plan.lines.map((l) => [l.lineNo, l.open, l.why])).toEqual([
      [1, false, "band 5 is taller than a row"],
      [2, false, "band 6 is not on the photo"],
      [3, false, "band 7 is not on the photo"],
      [4, false, "band 2 is given twice"],
      [5, true, null],
    ]);
  });

  it("where a closed band overlaps an open one, the closed one wins", () => {
    const a = band(2, 12); // reaches into row 3's band
    const m = openMask(W, H, [a, band(3)], [{ lineNo: 1, bandIndexes: [2] }]);
    const only3 = openMask(W, H, [band(3)], [{ lineNo: 1, bandIndexes: [3] }]);
    const alone = openMask(W, H, [a], [{ lineNo: 1, bandIndexes: [2] }]);
    let overlap = 0;
    for (let p = 0; p < m.length; p++) {
      if (only3[p] && alone[p]) overlap++;
      if (only3[p]) expect(m[p]).toBe(0);
    }
    expect(overlap).toBeGreaterThan(100);
  });

  it("two bands sharing an edge never both take a pixel on it", () => {
    const upper: Band = { index: 1, y0: 0, y1: 0, quad: [[10, 10.5], [200, 21.9], [200, 41.9], [10, 30.5]] };
    const lower: Band = { index: 2, y0: 0, y1: 0, quad: [[10, 30.5], [200, 41.9], [200, 61.9], [10, 50.5]] };
    const a = openMask(W, H, [upper], [{ lineNo: 1, bandIndexes: [1] }]);
    const b = openMask(W, H, [lower], [{ lineNo: 1, bandIndexes: [2] }]);
    let both = 0;
    let gap = 0;
    for (let y = 0; y < H; y++)
      for (let x = 12; x < 198; x++) {
        const p = y * W + x;
        if (a[p] && b[p]) both++;
        const ya = 30.5 + ((41.9 - 30.5) * (x + 0.5 - 10)) / 190;
        if (Math.abs(y + 0.5 - ya) < 0.4 && !a[p] && !b[p]) gap++;
      }
    expect(both).toBe(0);
    expect(gap).toBe(0);
  });
});

describe("the background", () => {
  it("is smooth: no letter, digit or bar survives, only the light across paper and desk", () => {
    const img = drawn();
    const bg = smoothBackground(img);
    let step = 0;
    for (let y = 0; y < H; y++)
      for (let x = 1; x < W; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) step = Math.max(step, Math.abs(bg[i + c] - bg[i - 4 + c]), y ? Math.abs(bg[i + c] - bg[i - W * 4 + c]) : 0);
      }
    expect(step).toBeLessThanOrEqual(6);
    let dark = 0;
    for (let p = 0; p < W * H; p++) if (lum(bg, p * 4) < 100) dark++;
    expect(dark).toBe(0);
  });
});

describe("the mark", () => {
  it("counts only before the image data: a mark appended after it is not a closed copy", () => {
    const plain = Buffer.from(png(drawn()));
    const body = Buffer.from(`tEXtComment\0pledge-as-spent: closed, only purchase lines open, v1`, "latin1");
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0);
    body.copy(chunk, 4);
    const iend = plain.length - 12;
    const late = Buffer.concat([plain.subarray(0, iend), chunk, plain.subarray(iend)]);
    expect(isClosedCopy(late)).toBe(false);
    expect(isClosedCopy(new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, 4, 1, 2]))).toBe(false);
  });
});

describe("the sample receipt", () => {
  const original = new Uint8Array(readFileSync(HERO_PHOTO));
  const { bands, purchaseLines } = heroClosing();
  const before = decodeRaster(original);
  const after = decodeRaster(closeReceipt({ bytes: original, mediaType: "image/png" }, bands, purchaseLines)!);
  const truth = JSON.parse(readFileSync(HERO_PHOTO.replace(/\.png$/, ".truth.json"), "utf8")) as { receipt: { pii: { kind: string; bbox: { x: number; y: number; w: number; h: number } }[] } };
  const darkIn = (img: Raster, b: { x: number; y: number; w: number; h: number }) => {
    let n = 0;
    for (let y = Math.floor(b.y * img.height); y < Math.ceil((b.y + b.h) * img.height); y++)
      for (let x = Math.floor(b.x * img.width); x < Math.ceil((b.x + b.w) * img.width); x++) if (lum(img.data, (y * img.width + x) * 4) < 120) n++;
    return n;
  };

  it("same size; the card number, the name and the member number are plain paper", () => {
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect(truth.receipt.pii.map((p) => p.kind).sort()).toEqual(["card_number", "member_id", "name"]);
    for (const p of truth.receipt.pii) {
      expect(darkIn(before, p.bbox), `${p.kind} printed`).toBeGreaterThan(30);
      expect(darkIn(after, p.bbox), p.kind).toBe(0);
    }
  });

  it("every one of its eleven lines stays exactly as printed", () => {
    expect(purchaseLines).toHaveLength(11);
    const open = openMask(after.width, after.height, bands, purchaseLines);
    for (const b of bands) {
      const [[x0, y0], , [x1, y1]] = b.quad;
      let n = 0;
      let same = 0;
      for (let y = Math.ceil(y0) + 1; y < Math.floor(y1) - 1; y++)
        for (let x = Math.ceil(x0) + 1; x < Math.floor(x1) - 1; x++) {
          const p = y * after.width + x;
          n++;
          if (open[p] && after.data[p * 4] === before.data[p * 4] && after.data[p * 4 + 1] === before.data[p * 4 + 1] && after.data[p * 4 + 2] === before.data[p * 4 + 2]) same++;
        }
      expect(same, `band ${b.index}`).toBe(n);
    }
  });
});
