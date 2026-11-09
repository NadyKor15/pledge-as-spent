// Closing measured on the held-out receipts, with no model and no network: the bands and the purchase lines come from
// the truth set, as if slicing and reading were perfect, so the numbers are the closing's own.
//   npx tsx tools/eval/close-measure.ts [--bands truth|slicer] [--out <dir>] [--only <id>]
//
// --bands truth (default): one band per printed row, measured on the page. --bands slicer: the reader's own bands
// (src/receipts/slice.ts, pixels only), each given to the printed row it covers most, as a perfect second reading
// would name it; this measures the slicing and the closing together. The controls always use the truth bands.
//
// The truth files hold the personal data's boxes but not the rows', so each receipt's page is rendered again from its
// spec (tools/receipts/render.ts, the same page that made the photo) and every printed row is measured on it: its
// corners taken through the photo's perspective by the browser itself. The re-render is checked against the truth:
// same photo size, the personal data's boxes where the truth has them, and the corner method against the browser's
// own box of each personal-data span. A receipt that fails a check is reported, not measured.
//
// A leak: any pixel of a personal-data box (card number, member number, name) inside the open area; and, read off the
// closed image itself, any dark pixel left in such a box. A lost line: any pixel of a purchase line's printed rows
// closed, or not the photo's own. Two controls show the counters can see: opening every row must leak every item,
// opening none must lose every line.

import { chromium, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeBytes, closeReceipt, decodeRaster, isClosedCopy, openMask, type Band, type PurchaseLine, type Raster } from "../../src/receipts/close";
import { rendered, rerenderProblem, type Geometry, type Quad } from "../receipts/rows";
import { Truth } from "../receipts/truth";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SET = path.join(ROOT, "eval/receipts/holdout");
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const MODE = arg("bands") ?? "truth";
if (MODE !== "truth" && MODE !== "slicer") throw new Error("--bands is truth or slicer");

const lum = (d: Uint8Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Pixels of a quad (the closing's own pixel rule), shrunk by one pixel so a shared edge counts for neither side. */
function inside(w: number, h: number, q: Quad): number[] {
  const m = openMask(w, h, [{ index: 1, y0: 0, y1: 0, quad: q }], [{ lineNo: 1, bandIndexes: [1] }]);
  const out: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (m[p] && m[p - 1] && m[p + 1] && m[p - w] && m[p + w]) out.push(p);
    }
  return out;
}

function rectPixels(w: number, h: number, b: { x: number; y: number; w: number; h: number }): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, Math.floor(b.y * h)); y < Math.min(h, Math.ceil((b.y + b.h) * h)); y++)
    for (let x = Math.max(0, Math.floor(b.x * w)); x < Math.min(w, Math.ceil((b.x + b.w) * w)); x++) out.push(y * w + x);
  return out;
}

/**
 * The reader's bands for the photo, and the purchase lines a perfect second reading would give them: a band belongs to
 * the printed row it covers most. src/receipts/slice.ts is loaded by path, so this file builds without it.
 */
async function slicerBands(bytes: Uint8Array, geo: Geometry, w: number, h: number): Promise<{ bands: Band[]; purchase: PurchaseLine[] }> {
  const mod = (await import(pathToFileURL(path.join(ROOT, "src/receipts/slice.ts")).href)) as { sliceReceipt: (image: { bytes: Uint8Array; mediaType: "image/png" }) => { bands: Band[] } };
  const { bands } = mod.sliceReceipt({ bytes, mediaType: "image/png" });
  const rows = geo.frames.map((f) => new Set(inside(w, h, f)));
  const owner = bands.map((b) => {
    const px = inside(w, h, b.quad);
    let best = -1;
    let most = 0;
    rows.forEach((r, i) => {
      const n = px.filter((q) => r.has(q)).length;
      if (n > most) [best, most] = [i + 1, n];
    });
    return best;
  });
  const purchase = geo.purchase.map((l) => ({ lineNo: l.lineNo, bandIndexes: bands.filter((_, k) => l.bandIndexes.includes(owner[k])).map((b) => b.index) }));
  return { bands, purchase };
}

interface Row {
  id: string;
  ok: boolean;
  problem: string | null;
  sameShot: boolean;
  cornerCheckPx: number;
  piiBoxGapMax: number;
  pii: number;
  leaks: number;
  darkLeftInPii: number;
  lines: number;
  lost: number;
  otherRowsOpen: number;
  openShare: number;
  controlAllOpenLeaks: number;
  controlNoneLost: number;
  file: string | null;
}

async function measure(page: Page, file: string, outDir: string): Promise<Row> {
  const t = Truth.parse(JSON.parse(await readFile(path.join(SET, file), "utf8")));
  const row: Row = { id: t.id, ok: false, problem: null, sameShot: false, cornerCheckPx: 0, piiBoxGapMax: 0, pii: t.receipt.pii.length, leaks: 0, darkLeftInPii: 0, lines: t.receipt.lines.length, lost: 0, otherRowsOpen: 0, openShare: 0, controlAllOpenLeaks: 0, controlNoneLost: 0, file: null };
  const { size, pii, geo, sameShot } = await rendered(page, t);
  row.sameShot = sameShot;
  row.cornerCheckPx = Math.round(geo.cornerCheckPx * 100) / 100;
  const check = rerenderProblem(t, { size, pii, geo, sameShot });
  row.piiBoxGapMax = check.piiBoxGapMax;
  if (check.problem) return { ...row, problem: check.problem };

  const bytes = new Uint8Array(await readFile(path.join(SET, t.image.file)));
  const before = decodeRaster(bytes);
  const { width: W, height: H } = before;
  const { bands, purchase } = MODE === "slicer" ? await slicerBands(bytes, geo, W, H) : { bands: geo.bands, purchase: geo.purchase };
  const closed = closeReceipt({ bytes, mediaType: "image/png" }, bands, purchase);
  if (!closed || !isClosedCopy(closed)) return { ...row, problem: "no closed copy" };
  const name = `${t.id}.closed${MODE === "slicer" ? ".slicer" : ""}.png`;
  await writeFile(path.join(outDir, name), closed);
  row.file = name;
  const after: Raster = decodeRaster(closed);
  const mask = openMask(W, H, bands, purchase);
  const open = mask.reduce((s, v) => s + v, 0);
  row.openShare = Math.round((open / (W * H)) * 1000) / 1000;

  const leaksWith = (m: Uint8Array) => t.receipt.pii.filter((p) => rectPixels(W, H, p.bbox!).some((q) => m[q])).length;
  row.leaks = leaksWith(mask);
  for (const p of t.receipt.pii) row.darkLeftInPii += rectPixels(W, H, p.bbox!).filter((q) => lum(after.data, q * 4) < 120).length;

  const purchaseRows = new Set(geo.purchase.flatMap((l) => l.bandIndexes)); // printed rows of the purchase lines, from the truth
  const same = (q: number) => after.data[q * 4] === before.data[q * 4] && after.data[q * 4 + 1] === before.data[q * 4 + 1] && after.data[q * 4 + 2] === before.data[q * 4 + 2];
  const lostWith = (m: Uint8Array, img: Raster | null) =>
    geo.purchase.filter((l) => l.bandIndexes.some((i) => inside(W, H, geo.frames[i - 1]).some((q) => !m[q] || (img !== null && !same(q))))).length;
  row.lost = lostWith(mask, after);
  row.otherRowsOpen = geo.frames.filter((f, i) => !purchaseRows.has(i + 1) && inside(W, H, f).some((q) => mask[q])).length;

  // Controls: the same counters must light up when the closing is wrong on purpose.
  const all = openMask(W, H, geo.bands, geo.bands.map((b) => ({ lineNo: b.index, bandIndexes: [b.index] })));
  row.controlAllOpenLeaks = leaksWith(all);
  const none = openMask(W, H, geo.bands, []);
  row.controlNoneLost = lostWith(none, null);
  const blank = decodeRaster(closeBytes(bytes, geo.bands, []));
  if (blank.width !== W || blank.height !== H) return { ...row, problem: "a closed copy changed size" };

  row.ok = row.leaks === 0 && row.darkLeftInPii === 0 && row.lost === 0 && row.otherRowsOpen === 0 && row.controlAllOpenLeaks === row.pii && row.controlNoneLost === row.lines;
  return row;
}

async function main() {
  const outDir = path.resolve(arg("out") ?? path.join(ROOT, "tmp/close-eval"));
  await mkdir(outDir, { recursive: true });
  const only = arg("only");
  const files = (await readdir(SET)).filter((f) => f.endsWith(".truth.json") && (!only || f.startsWith(`${only}.`))).sort();
  if (!files.length) throw new Error("no receipts match");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const rows: Row[] = [];
  try {
    for (const f of files) {
      const r = await measure(page, f, outDir);
      rows.push(r);
      console.log(`${r.id}  ${r.ok ? "ok" : "FAIL"}  leaks ${r.leaks}/${r.pii}  dark ${r.darkLeftInPii}  lost ${r.lost}/${r.lines}  other rows open ${r.otherRowsOpen}  controls ${r.controlAllOpenLeaks}/${r.pii} ${r.controlNoneLost}/${r.lines}${r.problem ? `  ${r.problem}` : ""}`);
    }
  } finally {
    await browser.close();
  }
  const sum = (k: keyof Row) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const measured = rows.filter((r) => !r.problem);
  const totals = {
    receipts: rows.length,
    measured: measured.length,
    pii: sum("pii"),
    leaks: sum("leaks"),
    darkLeftInPii: sum("darkLeftInPii"),
    lines: sum("lines"),
    lost: sum("lost"),
    otherRowsOpen: sum("otherRowsOpen"),
    controlAllOpenLeaks: sum("controlAllOpenLeaks"),
    controlNoneLost: sum("controlNoneLost"),
    sameShot: rows.filter((r) => r.sameShot).length,
    gate: measured.length === rows.length && rows.every((r) => r.ok),
  };
  const at = new Date().toISOString();
  await writeFile(path.join(outDir, `close-measure-${MODE}.json`), `${JSON.stringify({ at, bands: MODE, totals, rows }, null, 1)}\n`);
  const md = [
    `Closing on the held-out set with ${MODE === "truth" ? "one band per printed row, measured on the page" : "the reader's own pixel bands"}, ${at}: ${totals.measured} of ${totals.receipts} receipts measured.`,
    "",
    `| | Count |`,
    `|---|---|`,
    `| Personal data items with a pixel in the open area | ${totals.leaks} of ${totals.pii} |`,
    `| Dark pixels left inside personal-data boxes on the closed images | ${totals.darkLeftInPii} |`,
    `| Purchase lines with a pixel closed or changed | ${totals.lost} of ${totals.lines} |`,
    `| Other printed rows (header, totals, payment) with a pixel open | ${totals.otherRowsOpen} |`,
    `| Control, every row opened: personal data items caught | ${totals.controlAllOpenLeaks} of ${totals.pii} |`,
    `| Control, no row opened: purchase lines caught as lost | ${totals.controlNoneLost} of ${totals.lines} |`,
    `| Re-render identical to the photo, byte for byte | ${totals.sameShot} of ${totals.receipts} |`,
    "",
    `Gate (0 leaks, 0 lost lines, both controls light up on every receipt): ${totals.gate ? "passed" : "NOT passed"}.`,
  ].join("\n");
  await writeFile(path.join(outDir, `close-measure-${MODE}.md`), `${md}\n`);
  console.log(`\n${md}\n\nImages and numbers: ${outDir}`);
  if (!totals.gate) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
