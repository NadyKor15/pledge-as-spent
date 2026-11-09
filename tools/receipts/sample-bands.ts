// The printed rows of a sample receipt whose reading is the recorded one (the Florida drive's sample, the synthetic
// receipt fl-01 of a fictional Hallandale Beach store), so the demo publishes it closed to its purchase lines with no model call. The page that
// made the photo is rendered again from its truth's spec and every printed row measured on the photo
// (tools/receipts/rows.ts, as the closing is measured and as the cheat page's receipts are closed); each purchase line
// of the recorded reading gets the rows its truth line is printed on (name rows and its quantity row).
// The Kitasora sample does not need this: it is closed by the bands of Meta's own answer (eval/live/shipped/hero-ja-01.meta.json).
//   npx tsx tools/receipts/sample-bands.ts [florida]
// Writes eval/live/shipped/<sample>-sample.bands.json; src/server/reading.ts closes the sample with it.
// Refused, with nothing written: a photo that is not the truth's, a recorded reading whose lines are not the truth's,
// a re-render that does not match the photo, a line that cannot be opened, or a closed copy with any personal data
// open or print left in its box.

import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeReceipt, isClosedCopy, openPlan, type Band } from "../../src/receipts/close";
import { sha256Hex } from "../../src/receipts/hash";
import { Recordings } from "../../src/receipts/recorded";
import { closedLeak, rendered, rerenderProblem } from "./rows";
import { Truth } from "./truth";

const ROOT = path.resolve(import.meta.dirname, "../..");
const round = (n: number) => Math.round(n * 100) / 100;

/** Samples served with their recorded reading: the photo judges upload, and the truth of the receipt it is a copy of. */
const SAMPLES: Record<string, { photo: string; truth: string }> = {
  florida: { photo: "eval/receipts/florida/fl-01.png", truth: "eval/receipts/florida/fl-01.truth.json" },
};

async function main() {
  const name = process.argv[2] ?? "florida";
  const sample = SAMPLES[name];
  if (!sample) throw new Error(`no sample "${name}"; the samples are ${Object.keys(SAMPLES).join(", ")}`);
  const t = Truth.parse(JSON.parse(await readFile(path.join(ROOT, sample.truth), "utf8")));
  const bytes = new Uint8Array(await readFile(path.join(ROOT, sample.photo)));
  const sha = sha256Hex(bytes);
  if (sha !== t.image.sha256) throw new Error(`${name}: the photo is not the one the truth describes`);
  const recordings = Recordings.parse(JSON.parse(await readFile(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")));
  const reading = recordings.readings[sha];
  if (!reading) throw new Error(`${name}: the photo has no recorded reading`);
  const same = reading.lines.length === t.receipt.lines.length && reading.lines.every((l, i) => l.lineNo === t.receipt.lines[i].lineNo && l.amountMinor === t.receipt.lines[i].amountMinor);
  if (!same) throw new Error(`${name}: the recorded reading's lines are not the truth's, so the truth's rows cannot be given to them`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const r = await rendered(page, t);
    const { problem } = rerenderProblem(t, r);
    if (problem) throw new Error(`${name}: ${problem}`);
    const bands: Band[] = r.geo.bands.map((b) => ({ index: b.index, y0: round(b.y0), y1: round(b.y1), quad: b.quad.map(([x, y]) => [round(x), round(y)] as [number, number]) }));
    const purchaseLines = r.geo.purchase;
    const plan = openPlan(bands, purchaseLines);
    const shut = plan.lines.filter((l) => !l.open);
    if (shut.length || plan.lines.length !== reading.lines.length) throw new Error(`${name}: lines not opened: ${shut.map((l) => `${l.lineNo} (${l.why})`).join(", ")}`);
    const closed = closeReceipt({ bytes, mediaType: "image/png" }, bands, purchaseLines);
    if (!closed || !isClosedCopy(closed)) throw new Error(`${name}: no closed copy`);
    const leak = closedLeak(t, closed, bands, purchaseLines, bytes);
    if (leak) throw new Error(`${name}: ${leak}`);
    const out = {
      imageSha256: sha,
      madeBy: `tools/receipts/sample-bands.ts: the page of ${t.id} rendered again from its truth spec, each printed row measured on the photo (tools/receipts/rows.ts)`,
      bands,
      purchaseLines,
    };
    await writeFile(path.join(ROOT, "eval/live/shipped", `${name}-sample.bands.json`), `${JSON.stringify(out, null, 1)}\n`);
    if (process.argv.includes("--closed")) await writeFile(process.argv[process.argv.indexOf("--closed") + 1], closed);
    console.log(
      `${name}: ${purchaseLines.length} purchase lines open on ${plan.open.length} of ${bands.length} rows, ${t.receipt.pii.length} personal data items closed, corners within ${round(r.geo.cornerCheckPx)}px, re-render byte-identical: ${r.sameShot}`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
