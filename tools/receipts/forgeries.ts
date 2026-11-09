// The forged receipts of "Try to cheat the receipt" (src/server/cheat.ts): four from the receipt sets and one made
// here, a real-looking receipt whose total was raised by hand.
//   npx tsx tools/receipts/forgeries.ts
// Writes eval/cheat/cheat-total-ja.{png,truth.json} (outside eval/receipts: the benchmark sets stay as they are),
// public/cheat/<id>.jpg (personal data blurred, as the app publishes a receipt) and src/server/forgeries.json: each
// photo's fingerprints and its recorded reading, which is the set's truth. No model is asked anything.

import { chromium } from "@playwright/test";
import jpeg from "jpeg-js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { dHash, sha256Hex } from "../../src/receipts/hash";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { redactImage } from "../../src/server/redact";
import { CATALOG, STORES } from "./catalog";
import { render } from "./generate";
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

/** The published copy: personal data blurred, then a JPEG small enough for a page of five. */
function publishable(png: Uint8Array, reading: ParsedReceipt): Buffer {
  const blurred = redactImage({ bytes: png, mediaType: "image/png" }, reading.pii);
  if (!blurred.bytes) throw new Error("personal data could not be blurred: not publishing this photo");
  const img = PNG.sync.read(Buffer.from(blurred.bytes));
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, 82).data);
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
  for (const s of SOURCES) {
    const png = new Uint8Array(await readFile(path.join(ROOT, s.file)));
    const t = Truth.parse(JSON.parse(await readFile(path.join(ROOT, s.truth), "utf8")));
    const sha = sha256Hex(png);
    if (sha !== t.image.sha256) throw new Error(`${s.file}: the photo is not the one its truth file describes`);
    const dh = dHash({ bytes: png, mediaType: "image/png" });
    if (!dh) throw new Error(`${s.file}: no perceptual hash`);
    const image = `/cheat/${s.id}.jpg`;
    await writeFile(path.join(ROOT, "public", image), publishable(png, t.receipt));
    out.push({ id: s.id, source: s.file, image, sha256: sha, dHash: dh, reading: t.receipt, labels: t.labels });
    console.log(`${s.id}  ${s.file}  ${sha.slice(0, 12)}`);
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
