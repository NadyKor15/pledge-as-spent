// Ships a real receipt read by tools/receipts/read-private.ts as a sample of a demo drive: only its closed copy and a
// cleaned saved answer enter the repository.
//   npx tsx tools/receipts/ship-private.ts <private dir>/<name>.json <private dir>/<name>.closed.jpg <sample id> [--scenario florida]
// Writes eval/receipts/florida/<sample id>.jpg (the closed copy, byte for byte) and eval/live/shipped/<sample id>.meta.json.
//
// The saved answer is what Meta answered on the upright original, keyed by the closed copy's bytes (that is what a judge
// uploads). It keeps the purchase lines, the store and its address (the zone check needs them) and the date; it drops
// what the receipt prints about people and the sale: the names and phone in `pii`, the receipt number, and the text of
// every printed row that is not a purchase line (cashier, register, transaction, payment, change). Refused, with nothing
// written: a closed copy that is not the one the reading made, a comparison that does not give back the stored
// classifications, or needs and rules other than the demo drive's.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dHash, sha256Hex } from "../../src/receipts/hash";
import { compareReadings } from "../../src/receipts/meta-reader";
import { classificationKey } from "../../src/receipts/recorded";
import { Band, LineBox, LineClassification, ParsedReceipt, SecondReading } from "../../src/receipts/types";
import { demoDrive, type DemoScenarioId } from "../../src/server/demo";

const ROOT = path.resolve(import.meta.dirname, "../..");

const Private = z.object({
  receiptId: z.string(),
  imageSha256: z.string(),
  closedSha256: z.string().nullable(),
  reading: ParsedReceipt,
  classifications: z.array(LineClassification),
  classifiedFor: z.string(),
  second: SecondReading,
  rawClassifications: z.object({ first: z.array(LineClassification), second: z.array(LineClassification), third: z.record(z.string(), ParsedReceipt.shape.lines.element.nullable()).optional() }),
  purchaseLines: z.array(z.object({ lineNo: z.number().int().positive(), bandIndexes: z.array(z.number().int().positive()) })),
  held: z.array(z.unknown()).optional(),
  lineBoxes: z.array(LineBox),
});

const [src, closedPath, sampleId] = process.argv.slice(2);
const scenario = (process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "florida") as DemoScenarioId;
if (!src || !closedPath || !sampleId || !/^[a-z0-9-]+$/.test(sampleId)) throw new Error("usage: ship-private.ts <private json> <closed jpg> <sample id> [--scenario florida]");

async function main() {
  const p = Private.parse(JSON.parse(await readFile(path.resolve(src), "utf8")));
  const closed = new Uint8Array(await readFile(path.resolve(closedPath)));
  const closedSha = sha256Hex(closed);
  if (closedSha !== p.closedSha256) throw new Error("this closed copy is not the one the reading made");

  const { drive, needs } = demoDrive("ship", "2026-11-09T00:00:00Z", scenario);
  const key = classificationKey(p.reading, needs, drive.rules);
  if (key !== p.classifiedFor) throw new Error("the lines were classified against other needs or rules than the demo drive's");
  const { lines, agreement } = compareReadings({ receipt: p.reading, second: p.second, needs, raw: p.rawClassifications });
  if (JSON.stringify(lines) !== JSON.stringify(p.classifications)) throw new Error("re-running the comparison does not give the stored classifications");

  const purchaseBands = new Set(p.purchaseLines.flatMap((l) => l.bandIndexes));
  const bandTexts = Object.fromEntries(Object.entries(p.second.bandTexts).filter(([k]) => purchaseBands.has(Number(k))));
  const reading: ParsedReceipt = { ...p.reading, receiptNumber: null, pii: p.reading.pii.map((x) => ({ kind: x.kind, text: "[closed]", bbox: null })) };
  // The cleaned reading still has to give the same classifications: nothing a line depends on was touched.
  if (classificationKey(reading, needs, drive.rules) !== key) throw new Error("cleaning changed what the lines were classified on");

  const out = {
    madeBy: "tools/receipts/ship-private.ts from a live Meta reading of a real receipt (reader meta, Muse Spark 1.3, read twice); names, phone, receipt number and every non-purchase row's text removed",
    receiptId: sampleId,
    set: "florida-real",
    imageSha256: closedSha,
    imageDHash: dHash({ bytes: closed, mediaType: "image/jpeg" }),
    reading,
    classifications: lines,
    classifiedFor: key,
    lineBoxes: agreement.lineBoxes,
    bands: z.array(Band).parse(p.second.bands),
    bandTexts,
    purchaseLines: agreement.purchaseLines,
    held: agreement.held,
  };
  const dir = path.join(ROOT, "eval/receipts/florida");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sampleId}.jpg`), closed);
  await writeFile(path.join(ROOT, "eval/live/shipped", `${sampleId}.meta.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ sampleId, closedSha256: closedSha, lines: lines.length, bandsKept: Object.keys(bandTexts).length, bandsDropped: Object.keys(p.second.bandTexts).length - Object.keys(bandTexts).length }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
