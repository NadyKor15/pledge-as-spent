// The forged receipts of "Try to cheat the receipt" (src/server/cheat.ts): four from the receipt sets and one made
// here, a real-looking receipt whose total was raised by hand.
//   npx tsx tools/receipts/forgeries.ts
// Writes eval/cheat/cheat-total-ja.{png,truth.json} (outside eval/receipts: the benchmark sets stay as they are),
// public/cheat/<id>.jpg (closed, as the app publishes a receipt: only the purchase lines open, the rest a plain
// background, src/receipts/close.ts) and src/server/forgeries.json: each photo's fingerprints and its recorded
// reading, which is the set's truth. No model is asked anything. The rows to open come from the generator's own page:
// each receipt is rendered again from its spec and its printed rows measured on the photo (tools/receipts/rows.ts, the
// same way the closing is measured), and a photo whose re-render does not match it is not published.
//   --keep-render: keep eval/cheat/cheat-total-ja.png as it is (its fingerprints are in the manifest).

import { chromium, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dHash, sha256Hex } from "../../src/receipts/hash";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { closeReceipt, decodeRaster, encodeRaster, isClosedCopy, openPlan } from "../../src/receipts/close";
import { CATALOG, STORES } from "./catalog";
import { render } from "./generate";
import { closedLeak, rendered, rerenderProblem } from "./rows";
import { SCENARIOS } from "./scenario";
import { photoParams } from "./sets";
import { buildSpec, specToClassifications, specToReceipt, type Entry, type ReceiptSpec } from "./spec";
import { Truth } from "./truth";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** How much the forger added to the printed subtotal and total, in yen. */
export const RAISED_BY = 9000;

/** A receipt from a store inside the zone, after the disaster, every line a need: only its total was changed by hand. */
export function editedTotalSpec(): ReceiptSpec {
  const cat = CATALOG.ja;
  const find = (en: string) => {
    const it = cat.needItems.find((i) => i.en === en);
    if (!it) throw new Error(`no catalog item "${en}"`);
    return it;
  };
  const entries: Entry[] = [
    { item: find("Snowmelt water 2 L"), qty: 6 },
    { item: find("Baby Love pants M, 38 count"), qty: 1 },
    { item: find("AA batteries, pack of 10"), qty: 1 },
  ];
  const real = buildSpec({
    id: "cheat-total-ja",
    set: "adversarial",
    locale: "ja",
    seed: 9101,
    store: STORES.ja[1],
    purchasedAt: "2026-11-06T10:14:00",
    entries,
    taxIncluded: true,
    photo: photoParams(9108),
    card: false,
    loyalty: false,
  });
  const total = real.totalMinor + RAISED_BY;
  const tendered = Math.ceil(total / 1000) * 1000;
  return {
    ...real,
    subtotalMinor: (real.subtotalMinor ?? real.totalMinor) + RAISED_BY,
    totalMinor: total,
    payment: { method: "cash", tenderedMinor: tendered, changeMinor: tendered - total, cardLast4: null },
  };
}

interface Source {
  id: string;
  /** The original photo, as a volunteer would send it. */
  file: string;
  truth: string;
}

const SOURCES: Source[] = [
  { id: "pre-disaster", file: "eval/receipts/adversarial/adv-predisaster-ja.png", truth: "eval/receipts/adversarial/adv-predisaster-ja.truth.json" },
  { id: "duplicate", file: "eval/receipts/hero/hero-ja-01.png", truth: "eval/receipts/hero/hero-ja-01.truth.json" },
  { id: "out-of-zone", file: "eval/receipts/adversarial/adv-outofzone-ja.png", truth: "eval/receipts/adversarial/adv-outofzone-ja.truth.json" },
  { id: "edited-total", file: "eval/cheat/cheat-total-ja.png", truth: "eval/cheat/cheat-total-ja.truth.json" },
  { id: "forbidden-items", file: "eval/receipts/adversarial/adv-rules-ja.png", truth: "eval/receipts/adversarial/adv-rules-ja.truth.json" },
];

export interface ForgeryFile {
  id: string;
  source: string;
  image: string;
  sha256: string;
  dHash: string;
  reading: ParsedReceipt;
  labels: LineClassification[];
}

/**
 * The published copy: the photo closed to its purchase lines (every line, funded or refused), then a JPEG small enough
 * for a page of five, still carrying the closing mark. Throws rather than publish a copy that is not closed, that
 * leaves a purchase line shut, or that shows any of the personal data.
 */
async function publishable(page: Page, png: Uint8Array, t: Truth): Promise<{ jpg: Buffer; open: number; lines: number; cornerPx: number }> {
  const r = await rendered(page, t);
  const { problem } = rerenderProblem(t, r);
  if (problem) throw new Error(`${t.id}: ${problem}: not publishing this photo`);
  const plan = openPlan(r.geo.bands, r.geo.purchase);
  const shut = plan.lines.filter((l) => !l.open);
  if (shut.length) throw new Error(`${t.id}: purchase lines ${shut.map((l) => `${l.lineNo} (${l.why})`).join(", ")} cannot be opened: not publishing this photo`);
  if (plan.lines.length !== t.receipt.lines.length) throw new Error(`${t.id}: ${plan.lines.length} lines placed, the reading has ${t.receipt.lines.length}`);
  const closed = closeReceipt({ bytes: png, mediaType: "image/png" }, r.geo.bands, r.geo.purchase);
  if (!closed || !isClosedCopy(closed)) throw new Error(`${t.id}: no closed copy: not publishing this photo`);
  const leak = closedLeak(t, closed, r.geo.bands, r.geo.purchase);
  if (leak) throw new Error(`${t.id}: ${leak}: not publishing this photo`);
  const raster = decodeRaster(closed);
  const jpg = encodeRaster(raster, "image/jpeg", { jpegQuality: 82 });
  if (!isClosedCopy(jpg)) throw new Error(`${t.id}: the JPEG lost the closing mark`);
  return { jpg, open: plan.open.length, lines: plan.lines.length, cornerPx: Math.round(r.geo.cornerCheckPx * 100) / 100 };
}

async function renderEditedTotal() {
  const spec = editedTotalSpec();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const { png, size, boxes } = await render(page, spec);
    const dir = path.join(ROOT, "eval/cheat");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${spec.id}.png`), png);
    const truth = Truth.parse({
      id: spec.id,
      set: spec.set,
      locale: spec.locale,
      seed: spec.seed,
      driveId: SCENARIOS.ja.drive.id,
      image: { file: `${spec.id}.png`, sha256: createHash("sha256").update(png).digest("hex"), mediaType: "image/png", width: size.width, height: size.height },
      receipt: specToReceipt(spec, boxes),
      labels: specToClassifications(spec),
      expect: spec.expect,
      spec,
    });
    await writeFile(path.join(dir, `${spec.id}.truth.json`), JSON.stringify(truth, null, 1) + "\n");
    console.log(`${spec.id}  ${size.width}x${size.height}  total ${truth.receipt.totalMinor} (lines ${truth.receipt.lines.reduce((s, l) => s + l.amountMinor, 0)})`);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!process.argv.includes("--keep-render")) await renderEditedTotal();
  const out: ForgeryFile[] = [];
  await mkdir(path.join(ROOT, "public/cheat"), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const s of SOURCES) {
      const png = new Uint8Array(await readFile(path.join(ROOT, s.file)));
      const t = Truth.parse(JSON.parse(await readFile(path.join(ROOT, s.truth), "utf8")));
      const sha = sha256Hex(png);
      if (sha !== t.image.sha256) throw new Error(`${s.file}: the photo is not the one its truth file describes`);
      const dh = dHash({ bytes: png, mediaType: "image/png" });
      if (!dh) throw new Error(`${s.file}: no perceptual hash`);
      const image = `/cheat/${s.id}.jpg`;
      const { jpg, open, lines, cornerPx } = await publishable(page, png, t);
      await writeFile(path.join(ROOT, "public", image), jpg);
      out.push({ id: s.id, source: s.file, image, sha256: sha, dHash: dh, reading: t.receipt, labels: t.labels });
      console.log(`${s.id}  ${s.file}  ${sha.slice(0, 12)}  closed: ${lines} purchase lines open on ${open} rows, ${t.receipt.pii.length} personal data items shut, corners within ${cornerPx}px`);
    }
  } finally {
    await browser.close();
  }
  await writeFile(path.join(ROOT, "src/server/forgeries.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`src/server/forgeries.json: ${out.length} forgeries`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
