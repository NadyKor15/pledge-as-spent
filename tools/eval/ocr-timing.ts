// What one receipt costs the local steps on a single page worker, as they would run in one serverless function:
// preparation, OCR, re-reading doubtful rows and cutting the tiles for the model, with cold start (traineddata
// load), CPU seconds, wall time and peak memory. No model calls.
//   npx tsx tools/eval/ocr-timing.ts [--set hero|v1|adversarial ...] [--dump <dir>]
// One worker and one process, so the CPU seconds are what a single core has to deliver.
// --dump writes each photo's OCR rows to <dir>/<id>.txt for reading by eye.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TesseractEngine } from "../../src/receipts/ocr";
import { prepImage } from "../../src/receipts/prep";
import { rereadDoubtfulRows } from "../../src/receipts/rows";
import { SCENARIOS } from "../receipts/scenario";
import { loadTruths, type SetName } from "./run";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RECEIPTS = path.join(ROOT, "eval/receipts");
const SCALE = 1.5; // the production reader's scale

const cpuSeconds = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

async function main() {
  const args = process.argv.slice(2);
  const sets = args.flatMap((a, i) => (args[i - 1] === "--set" ? [a as SetName] : []));
  const dump = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : null;
  if (dump) await mkdir(dump, { recursive: true });

  const rows: { id: string; locale: string; langs: string; first: boolean; prepMs: number; ocrWallMs: number; ocrCpuS: number; lines: number; rssMb: number }[] = [];
  const engines = new Map<string, TesseractEngine>();
  let peakRss = 0;
  for (const set of sets.length ? sets : (["hero", "v1", "adversarial"] as SetName[])) {
    for (const t of await loadTruths(set)) {
      const bytes = new Uint8Array(await readFile(path.join(RECEIPTS, set, t.image.file)));
      const langs = SCENARIOS[t.locale].languages;
      const key = langs.join("+");
      const first = !engines.has(key);
      if (first) {
        // One engine alive at a time: a function instance serves one language set at a time in the worst case.
        for (const e of engines.values()) await e.close();
        engines.clear();
        engines.set(key, new TesseractEngine(path.join(ROOT, "vendor/tessdata")));
      }
      const engine = engines.get(key)!;
      const t0 = performance.now();
      const prepared = prepImage({ bytes, mediaType: t.image.mediaType }, { scale: SCALE });
      const png = prepared.png();
      const t1 = performance.now();
      const c0 = cpuSeconds();
      const pageRows = await engine.recognize(png, langs);
      const lines = await rereadDoubtfulRows(prepared.image, pageRows, engine, langs);
      prepImage({ bytes, mediaType: t.image.mediaType }, { scale: 2 }).tiles();
      const t2 = performance.now();
      const rss = process.memoryUsage().rss / 1024 / 1024;
      peakRss = Math.max(peakRss, rss);
      rows.push({ id: t.id, locale: t.locale, langs: key, first, prepMs: Math.round(t1 - t0), ocrWallMs: Math.round(t2 - t1), ocrCpuS: Math.round((cpuSeconds() - c0) * 100) / 100, lines: lines.length, rssMb: Math.round(rss) });
      if (dump) await writeFile(path.join(dump, `${t.id}.txt`), lines.map((l) => l.text).join("\n") + "\n");
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
  }
  for (const e of engines.values()) await e.close();

  const warm = rows.filter((r) => !r.first);
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const pick = (xs: number[], q: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  const summary = {
    when: new Date().toISOString(),
    host: "Mac Studio, shared; one tesseract worker, one process",
    photos: rows.length,
    cold: rows.filter((r) => r.first).map((r) => ({ id: r.id, langs: r.langs, wallMs: r.ocrWallMs, cpuS: r.ocrCpuS })),
    warm: {
      ocrWallMsMedian: pick(warm.map((r) => r.ocrWallMs), 0.5),
      ocrWallMsMax: Math.max(...warm.map((r) => r.ocrWallMs)),
      ocrCpuSMedian: pick(warm.map((r) => r.ocrCpuS), 0.5),
      ocrCpuSMax: Math.max(...warm.map((r) => r.ocrCpuS)),
      prepMsMedian: pick(warm.map((r) => r.prepMs), 0.5),
      prepMsMax: Math.max(...warm.map((r) => r.prepMs)),
    },
    peakRssMb: Math.round(peakRss),
    rows,
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = path.join(ROOT, "eval/results", `ocr-timing-${stamp}.json`);
  await writeFile(out, JSON.stringify(summary, null, 1) + "\n");
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 1));
  console.log(`written ${path.relative(ROOT, out)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
