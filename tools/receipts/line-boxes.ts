// Where each line of the shipped sample receipt is printed, measured once on its photo with the production OCR steps:
// preparation at the reader's scale, Tesseract with the vendored traineddata, the re-read of doubtful rows and the
// digit repair from the photo's numbers the shipped run saw (its trace). No model call: the lines are the shipped
// reading's own, so a box is placed only where that reading's line and amount are printed.
//   npx tsx tools/receipts/line-boxes.ts [hero-ja-01]
// Writes eval/live/shipped/<id>.lines.json; the demo takes the sample receipt's boxes from there (src/server/reading.ts).

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchLineBoxes, TesseractEngine } from "../../src/receipts/ocr";
import { prepImage } from "../../src/receipts/prep";
import { repairDigits, rereadDoubtfulRows } from "../../src/receipts/rows";
import { LineBox, ParsedReceipt } from "../../src/receipts/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCALE = 1.5; // the production reader's scale (src/receipts/ocr.ts)

async function main() {
  const id = process.argv[2] ?? "hero-ja-01";
  const shippedPath = path.join(ROOT, "eval/live/shipped", `${id}.json`);
  const shipped = JSON.parse(await readFile(shippedPath, "utf8")) as { set: string; imageSha256: string; reading: unknown; trace: { photoNumbers: string[] } };
  const reading = ParsedReceipt.parse(shipped.reading);
  const bytes = new Uint8Array(await readFile(path.join(ROOT, "eval/receipts", shipped.set, `${id}.png`)));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== shipped.imageSha256) throw new Error(`${id}: the photo is not the one the shipped answer was made from`);

  const languages = ["ja", "en"];
  const engine = new TesseractEngine(path.join(ROOT, "vendor/tessdata"));
  try {
    const prepared = prepImage({ bytes, mediaType: "image/png" }, { scale: SCALE });
    const first = await engine.recognize(prepared.png(), languages);
    const reread = await rereadDoubtfulRows(prepared.image, first, engine, languages);
    const { lines } = repairDigits(reread, shipped.trace.photoNumbers);
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const lineBoxes = matchLineBoxes(reading.lines, lines, reading.currency === "JPY" ? 0 : 2).map((b) => {
      const o = prepared.toOriginal(b.box);
      return LineBox.parse({ lineNo: b.lineNo, box: { x: round(o.x), y: round(o.y), w: round(o.w), h: round(o.h) } });
    });
    const missing = reading.lines.filter((l) => !lineBoxes.some((b) => b.lineNo === l.lineNo)).map((l) => l.lineNo);
    const tesseract = (JSON.parse(await readFile(path.join(ROOT, "node_modules/tesseract.js/package.json"), "utf8")) as { version: string }).version;
    const out = {
      imageSha256: sha,
      madeBy: `tools/receipts/line-boxes.ts: tesseract.js ${tesseract} jpn+eng (vendor/tessdata), scale ${SCALE}, rows re-read and repaired as in OcrNovaReader`,
      madeAt: new Date().toISOString(),
      lineBoxes,
    };
    await writeFile(path.join(ROOT, "eval/live/shipped", `${id}.lines.json`), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${id}: ${lineBoxes.length} of ${reading.lines.length} lines placed${missing.length ? `; no box for ${missing.join(", ")}` : ""}`);
  } finally {
    await engine.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
