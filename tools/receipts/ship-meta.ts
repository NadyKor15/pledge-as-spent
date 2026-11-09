// Ships a real Meta reading as the saved answer of a sample receipt, so the demo never calls a model for it.
//   npx tsx tools/receipts/ship-meta.ts <eval/live/meta/<id>.json> <eval/live/shipped/<id>.json> [--needs hero|<locale>]
// Takes what the benchmark saved from the live run (reading A, reading B, the raw classifications of both), re-runs
// the same comparison the server runs (src/receipts/meta-reader.ts), and checks it gives back the classifications the
// run stored. The perceptual hash is computed from the photo itself. Never a hand-written reading.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareReadings } from "../../src/receipts/meta-reader";
import { dHash } from "../../src/receipts/hash";
import { LineClassification, ParsedReceipt, SecondReading } from "../../src/receipts/types";
import { classificationKey } from "../../src/receipts/recorded";
import { HERO_NEEDS, SCENARIOS } from "./scenario";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dirname, "../..");

const Live = z.object({
  receiptId: z.string(),
  set: z.string(),
  imageSha256: z.string(),
  reading: ParsedReceipt,
  classifications: z.array(LineClassification),
  classifiedFor: z.string(),
  second: SecondReading,
  rawClassifications: z.object({ first: z.array(LineClassification), second: z.array(LineClassification) }),
});

const [src, dst] = process.argv.slice(2);
const needsArg = process.argv.includes("--needs") ? process.argv[process.argv.indexOf("--needs") + 1] : "hero";
if (!src || !dst) throw new Error("usage: tsx tools/receipts/ship-meta.ts <live json> <shipped json> [--needs hero|ja|es|tr|en]");
const live = Live.parse(JSON.parse(readFileSync(path.resolve(src), "utf8")));
const scenario = needsArg === "hero" ? { ...SCENARIOS.ja, needs: HERO_NEEDS } : SCENARIOS[needsArg as keyof typeof SCENARIOS];
if (!scenario) throw new Error(`unknown needs ${needsArg}`);

const photo = path.join(ROOT, "eval/receipts", live.set, `${live.receiptId}.png`);
const bytes = new Uint8Array(readFileSync(photo));
const sha = createHash("sha256").update(bytes).digest("hex");
if (sha !== live.imageSha256) throw new Error(`the saved reading is of another photo (${live.imageSha256} vs ${sha})`);

const key = classificationKey(live.reading, scenario.needs, scenario.drive.rules);
if (key !== live.classifiedFor) throw new Error("the run classified these lines against other needs or rules");
const { lines, agreement } = compareReadings({ receipt: live.reading, second: live.second, needs: scenario.needs, raw: live.rawClassifications });
if (JSON.stringify(lines) !== JSON.stringify(live.classifications)) throw new Error("re-running the comparison does not give the stored classifications");

const out = {
  madeBy: "tools/receipts/ship-meta.ts from the benchmark's live Meta run (reader meta, Muse Spark 1.3, read twice)",
  receiptId: live.receiptId,
  set: live.set,
  imageSha256: sha,
  imageDHash: dHash({ bytes, mediaType: "image/png" }),
  reading: live.reading,
  classifications: lines,
  classifiedFor: key,
  lineBoxes: agreement.lineBoxes,
  bands: live.second.bands,
  bandTexts: live.second.bandTexts,
  purchaseLines: agreement.purchaseLines,
  held: agreement.held,
};
writeFileSync(path.resolve(dst), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${dst}: ${lines.length} lines, ${agreement.purchaseLines.length} purchase lines with rows, ${agreement.held.length} held`);
