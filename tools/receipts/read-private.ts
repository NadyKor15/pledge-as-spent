// Reads one photo that is not part of a receipt set (a real receipt) by the production's Meta path, and closes it.
// Everything it writes goes to <out dir>, which must be outside the repository: the photo and the model's answer carry
// what the receipt prints (store, card digits, member number), and only the closed copy may ever be published.
//
//   tools/p3/with-meta-nadya.sh npx tsx tools/receipts/read-private.ts read <photo> <out dir>
//     Muse Spark reads the upright photo twice (whole photo; numbered rows): <out>/<name>.read.json.
//   tools/p3/with-meta-nadya.sh npx tsx tools/receipts/read-private.ts classify <photo> <out dir> [--scenario florida]
//     The classification of both readings against the demo drive's needs and rules, the third readings of disputed
//     lines (as on the server), the comparison, the drive's checks, and the closed copy:
//     <out>/<name>.json (the format of eval/live/meta), <out>/<name>.closed.jpg.
//
// Every model call is paid from Nadezhda's Meta credits and written to eval/meta-spend-ledger.jsonl (entries
// "read-meta-eval:", ceiling META_SPEND_MAX_USD, default $5). Nothing else is called.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkReceipt } from "../../src/receipts/checks";
import { closeReceipt } from "../../src/receipts/close";
import { dHash, sha256Hex } from "../../src/receipts/hash";
import { AgreeingClassifier, MetaRawClassifier, MetaThirdReader, MetaTwoReadings } from "../../src/receipts/meta-reader";
import { exifOrientation, uprightImage } from "../../src/receipts/orient";
import { classificationKey } from "../../src/receipts/recorded";
import { PrefixJsonlSpendLedger, SpendCap } from "../../src/receipts/spend";
import { ParsedReceipt, SecondReading, type ReceiptImage } from "../../src/receipts/types";
import { DEMO_SCENARIOS, demoDrive, type DemoScenarioId } from "../../src/server/demo";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREFIX = "read-meta-eval:";

const [cmd, photo, outArg] = process.argv.slice(2);
const scenarioArg = (process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "florida") as DemoScenarioId;
if (!["read", "classify"].includes(cmd) || !photo || !outArg) throw new Error("usage: read-private.ts read|classify <photo> <out dir> [--scenario florida]");
const out = path.resolve(outArg);
if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error("the out dir must be outside the repository");
const name = path.basename(photo).replace(/\.[^.]+$/, "");

function metaOptions() {
  const apiKey = process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error("META_MODEL_API_KEY is not set: run through tools/p3/with-meta-nadya.sh");
  const cap = new SpendCap(new PrefixJsonlSpendLedger(path.join(ROOT, "eval/meta-spend-ledger.jsonl"), PREFIX), Number(process.env.META_SPEND_MAX_USD ?? "5"));
  return { apiKey, cap, prefix: PREFIX, ...(process.env.META_MODEL_API_BASE_URL ? { baseUrl: process.env.META_MODEL_API_BASE_URL } : {}) };
}

async function loadUpright(): Promise<{ image: ReceiptImage; originalSha: string; orientation: number }> {
  const bytes = new Uint8Array(await readFile(path.resolve(photo)));
  const mediaType = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes[0] === 0x89 ? "image/png" : null;
  if (!mediaType) throw new Error("only JPEG and PNG photos");
  const image = uprightImage({ bytes, mediaType });
  return { image, originalSha: sha256Hex(bytes), orientation: mediaType === "image/jpeg" ? exifOrientation(bytes) : 1 };
}

const Read = z.object({ uprightSha256: z.string(), reading: ParsedReceipt, second: SecondReading });

async function main() {
  await mkdir(out, { recursive: true });
  const { image, originalSha, orientation } = await loadUpright();
  const o = metaOptions();
  const before = await o.cap.ledger.total();
  const readFile_ = path.join(out, `${name}.read.json`);

  if (cmd === "read") {
    const t0 = Date.now();
    const r = await new MetaTwoReadings(o).read(image, { currency: "USD", languages: ["en"] });
    const spent = (await o.cap.ledger.total()) - before;
    await writeFile(readFile_, JSON.stringify({ photo: path.basename(photo), originalSha256: originalSha, exifOrientation: orientation, uprightSha256: sha256Hex(image.bytes), reading: r.receipt, second: r.second, usage: r.usage, latencyMs: Date.now() - t0, spentUsd: spent }, null, 1) + "\n");
    console.log(JSON.stringify({ step: "read", photo: path.basename(photo), exifOrientation: orientation, lines: r.receipt.lines.length, rowsB: r.second.bands.length, readBError: r.second.error, spentUsd: Number(spent.toFixed(6)), ledgerUsd: Number((await o.cap.ledger.total()).toFixed(6)) }));
    return;
  }

  if (!existsSync(readFile_)) throw new Error(`read first: ${readFile_} is missing`);
  const saved = Read.parse(JSON.parse(await readFile(readFile_, "utf8")));
  if (saved.uprightSha256 !== sha256Hex(image.bytes)) throw new Error("the saved readings are of another photo");
  const { drive, needs } = demoDrive("read-private", new Date().toISOString(), scenarioArg);
  const sc = DEMO_SCENARIOS[scenarioArg];
  const t0 = Date.now();
  const classifier = new AgreeingClassifier(new MetaRawClassifier(o), new MetaThirdReader(o));
  const { lines, agreement } = await classifier.classify({ receipt: saved.reading, second: saved.second, needs, rules: drive.rules, image });
  const flags = checkReceipt({ receipt: saved.reading, drive, known: [], receiptId: name } as never);
  const closed = agreement ? closeReceipt(image, saved.second.bands, agreement.purchaseLines) : null;
  if (closed) await writeFile(path.join(out, `${name}.closed.jpg`), closed);
  const spent = (await o.cap.ledger.total()) - before;
  const rec = {
    receiptId: name,
    set: "private",
    scenario: sc.id,
    imageSha256: saved.uprightSha256,
    imageDHash: dHash(image),
    closedSha256: closed ? sha256Hex(closed) : null,
    reading: saved.reading,
    classifications: lines,
    classifiedFor: classificationKey(saved.reading, needs, drive.rules),
    second: saved.second,
    ...(agreement ? { rawClassifications: agreement.raw, purchaseLines: agreement.purchaseLines, held: agreement.held, lineBoxes: agreement.lineBoxes } : {}),
    flags,
    latencyMs: Date.now() - t0,
    spentUsd: spent,
  };
  await writeFile(path.join(out, `${name}.json`), JSON.stringify(rec, null, 1) + "\n");
  console.log(
    JSON.stringify({
      step: "classify",
      photo: path.basename(photo),
      verdicts: lines.map((l) => [l.lineNo, l.verdict, l.needId, l.ruleCode]),
      flags: flags.map((f) => f.code),
      purchaseLines: agreement?.purchaseLines.length ?? 0,
      closed: Boolean(closed),
      spentUsd: Number(spent.toFixed(6)),
      ledgerUsd: Number((await o.cap.ledger.total()).toFixed(6)),
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
