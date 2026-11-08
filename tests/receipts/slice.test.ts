import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { drawNumber, findRows, sliceReceipt, type Band } from "../../src/receipts/slice";
import type { Rgba } from "../../src/receipts/prep";

// The second reading and the closed copy both stand on these bands: every printed row in exactly one band,
// in reading order, and each band's place on the original photo, so it can be shown or closed by pixels alone.

const ROOT = path.resolve(__dirname, "../..");
const png = (file: string) => ({ bytes: new Uint8Array(readFileSync(path.join(ROOT, file))), mediaType: "image/png" as const });

/** A plain receipt: grey desk, white paper, `rows` rows of dark "words" (blocks), each `rowH` tall, 2 rows apart. */
function synthetic(rows: number, opts: { rowH?: number; tiltDeg?: number } = {}): { bytes: Uint8Array; rowsY: number[] } {
  const W = 500;
  const H = 120 + rows * 34;
  const rowH = opts.rowH ?? 14;
  const t = ((opts.tiltDeg ?? 0) * Math.PI) / 180;
  const img = new PNG({ width: W, height: H });
  const rowsY: number[] = [];
  for (let i = 0; i < rows; i++) rowsY.push(60 + i * 34);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // Rotate the page around its centre: (x, y) on the photo -> (u, v) on the paper.
      const dx = x - W / 2;
      const dy = y - H / 2;
      const u = dx * Math.cos(t) + dy * Math.sin(t) + W / 2;
      const v = -dx * Math.sin(t) + dy * Math.cos(t) + H / 2;
      const onPaper = u > 60 && u < W - 60 && v > 25 && v < H - 25;
      let c = onPaper ? 245 : 70;
      if (onPaper) {
        const row = rowsY.findIndex((ry) => v >= ry && v < ry + rowH);
        // Words: blocks with gaps, and an amount at the right end of each row.
        if (row >= 0 && ((u > 90 && u < 300 && Math.floor((u - 90) / 30) % 2 === 0) || (u > 360 && u < 420))) c = 25;
      }
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  return { bytes: new Uint8Array(PNG.sync.write(img)), rowsY };
}

const inside = (q: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

const ordered = (bands: Band[]) => bands.every((b, i) => b.index === i + 1 && b.y1 > b.y0 && (i === 0 || b.y0 >= bands[i - 1].y1));

describe("sliceReceipt", () => {
  it("finds every printed row of a straight receipt, once, top to bottom", () => {
    const s = synthetic(12);
    const out = sliceReceipt({ bytes: s.bytes, mediaType: "image/png" });
    expect(out.bands).toHaveLength(12);
    expect(ordered(out.bands)).toBe(true);
    // Each row's middle (a word and its amount) lies inside its own band on the original photo, and in no other.
    s.rowsY.forEach((ry, i) => {
      for (const x of [100, 390]) {
        const hits = out.bands.filter((b) => inside(b.quad, x, ry + 7));
        expect(hits.map((b) => b.index)).toEqual([i + 1]);
      }
    });
  });

  it("straightens a tilted receipt, so rows do not merge, and the bands follow the slant on the photo", () => {
    const s = synthetic(14, { tiltDeg: 3.5 });
    const out = sliceReceipt({ bytes: s.bytes, mediaType: "image/png" });
    expect(Math.abs(out.tiltDeg)).toBeGreaterThan(2.5);
    expect(out.bands).toHaveLength(14);
    expect(ordered(out.bands)).toBe(true);
    // The quad of a band is slanted: its right corners sit lower (or higher) than its left ones.
    const q = out.bands[5].quad;
    expect(Math.abs(q[1][1] - q[0][1])).toBeGreaterThan(8);
  });

  it("finds nothing on a blank sheet of paper", () => {
    expect(sliceReceipt({ bytes: synthetic(0).bytes, mediaType: "image/png" }).bands).toEqual([]);
  });

  it("lays the cuts on numbered sheets, at most 34 to a sheet, every band on one sheet", () => {
    const out = sliceReceipt(png("eval/receipts/hero/hero-ja-01.png"));
    expect(out.bands.length).toBeGreaterThan(34);
    expect(out.sheets).toHaveLength(Math.ceil(out.bands.length / 34));
    expect(out.sheets[0]).toMatchObject({ first: 1, last: 34, mediaType: "image/jpeg" });
    expect(out.sheets.at(-1)!.last).toBe(out.bands.length);
    const page = jpeg.decode(out.sheets[0].bytes, { useTArray: true });
    expect(page.height).toBe(34 * 50 + 10);
  });

  it("puts every row the OCR measured on the sample receipt inside a band", () => {
    const out = sliceReceipt(png("eval/receipts/hero/hero-ja-01.png"));
    const boxes = JSON.parse(readFileSync(path.join(ROOT, "eval/live/shipped/hero-ja-01.lines.json"), "utf8")).lineBoxes as { box: { x: number; y: number; w: number; h: number } }[];
    expect(boxes.length).toBeGreaterThan(5);
    for (const { box } of boxes) {
      // The left end of the row (the product name) and its right end (the amount).
      for (const fx of [0.05, 0.95]) {
        const x = (box.x + fx * box.w) * out.width;
        const y = (box.y + box.h / 2) * out.height;
        expect(out.bands.some((b) => inside(b.quad, x, y))).toBe(true);
      }
    }
  });

  it("covers each held-out receipt's personal data with a band (so the closed copy can close it by band)", () => {
    for (const id of ["ja-01", "es-01", "en-02", "tr-03"]) {
      const out = sliceReceipt(png(`eval/receipts/holdout/holdout-${id}.png`));
      expect(ordered(out.bands)).toBe(true);
      const truth = JSON.parse(readFileSync(path.join(ROOT, `eval/receipts/holdout/holdout-${id}.truth.json`), "utf8"));
      for (const p of truth.receipt.pii) {
        const x = (p.bbox.x + p.bbox.w / 2) * out.width;
        const y = (p.bbox.y + p.bbox.h / 2) * out.height;
        expect(out.bands.some((b) => inside(b.quad, x, y)), `${id} ${p.kind}`).toBe(true);
      }
    }
  });

  it("refuses an image it cannot decode instead of guessing", () => {
    expect(() => sliceReceipt({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/webp" })).toThrow();
  });
});

describe("findRows and drawNumber", () => {
  it("drops specks and a dotted rule thinner than a third of a row of type", () => {
    const W = 300;
    const H = 200;
    const data = new Uint8Array(W * H * 4).fill(245);
    const dark = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.fill(20, (y * W + x) * 4, (y * W + x) * 4 + 3);
    };
    for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) dark(30 + k * 40, 30 + i * 40, 25, 14); // three rows of type
    for (let k = 0; k < 40; k++) dark(30 + k * 6, 150, 3, 2); // a dotted rule
    const rows = findRows({ width: W, height: H, data });
    expect(rows).toHaveLength(3);
  });

  it("draws a number in red pixels, wider for more digits", () => {
    const page: Rgba = { width: 100, height: 40, data: new Uint8Array(100 * 40 * 4).fill(255) };
    drawNumber(page, 12, 2, 2, 3);
    const red = (x0: number, x1: number) => {
      let n = 0;
      for (let y = 0; y < 40; y++) for (let x = x0; x < x1; x++) if (page.data[(y * 100 + x) * 4 + 1] === 0) n++;
      return n;
    };
    expect(red(0, 18)).toBeGreaterThan(0);
    expect(red(20, 36)).toBeGreaterThan(0);
    expect(red(40, 100)).toBe(0);
  });
});
