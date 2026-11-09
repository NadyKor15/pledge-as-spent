// The printed rows of the shipped sample receipt, so the demo can publish it closed to its purchase lines without a
// reader that finds rows. The page that made the photo is rendered again from its truth's spec and every printed row
// measured on the photo (tools/receipts/rows.ts, as the closing is measured and as the cheat page's receipts are
// closed); each purchase line of the shipped reading gets the rows its truth line is printed on (name rows and its
// quantity row). No model call.
//   npx tsx tools/receipts/sample-bands.ts [hero-ja-01]
// Writes eval/live/shipped/<id>.bands.json; the demo closes the sample receipt with it (src/server/reading.ts).
// Refused, with nothing written: a re-render that does not match the photo, a shipped reading whose lines are not the
// truth's, a line that cannot be opened, or a closed copy with any personal data open or print left in its box.

import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeReceipt, isClosedCopy, openPlan, type Band } from "../../src/receipts/close";
import { sha256Hex } from "../../src/receipts/hash";
import { ParsedReceipt } from "../../src/receipts/types";
import { closedLeak, rendered, rerenderProblem } from "./rows";
import { Truth } from "./truth";

const ROOT = path.resolve(import.meta.dirname, "../..");
/** The hero receipt's corners sit 1.03 px from the browser's own boxes; the closed copy is checked directly below. */
const CORNER_TOLERANCE_PX = 2;
const round = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const id = process.argv[2] ?? "hero-ja-01";
  const shipped = JSON.parse(await readFile(path.join(ROOT, "eval/live/shipped", `${id}.json`), "utf8")) as { set: string; imageSha256: string; reading: unknown };
  const reading = ParsedReceipt.parse(shipped.reading);
  const t = Truth.parse(JSON.parse(await readFile(path.join(ROOT, "eval/receipts", shipped.set, `${id}.truth.json`), "utf8")));
  const bytes = new Uint8Array(await readFile(path.join(ROOT, "eval/receipts", shipped.set, t.image.file)));
  const sha = sha256Hex(bytes);
  if (sha !== shipped.imageSha256 || sha !== t.image.sha256) throw new Error(`${id}: the photo is not the one the shipped answer and the truth describe`);
  const same = (a: ParsedReceipt["lines"], b: ParsedReceipt["lines"]) => a.length === b.length && a.every((l, i) => l.lineNo === b[i].lineNo && l.amountMinor === b[i].amountMinor);
  if (!same(reading.lines, t.receipt.lines)) throw new Error(`${id}: the shipped reading's lines are not the truth's, so the truth's rows cannot be given to them`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const r = await rendered(page, t);
    const { problem } = rerenderProblem(t, r, CORNER_TOLERANCE_PX);
    if (problem) throw new Error(`${id}: ${problem}`);
    const bands: Band[] = r.geo.bands.map((b) => ({ index: b.index, y0: round(b.y0), y1: round(b.y1), quad: b.quad.map(([x, y]) => [round(x), round(y)] as [number, number]) }));
    const purchaseLines = r.geo.purchase;
    const plan = openPlan(bands, purchaseLines);
    const shut = plan.lines.filter((l) => !l.open);
    if (shut.length || plan.lines.length !== reading.lines.length) throw new Error(`${id}: lines not opened: ${shut.map((l) => `${l.lineNo} (${l.why})`).join(", ")}`);
    const closed = closeReceipt({ bytes, mediaType: "image/png" }, bands, purchaseLines);
    if (!closed || !isClosedCopy(closed)) throw new Error(`${id}: no closed copy`);
    const leak = closedLeak(t, closed, bands, purchaseLines);
    if (leak) throw new Error(`${id}: ${leak}`);
    const out = {
      imageSha256: sha,
      madeBy: "tools/receipts/sample-bands.ts: the photo's page rendered again from its truth spec, each printed row measured on the photo (tools/receipts/rows.ts)",
      madeAt: new Date().toISOString(),
      bands,
      purchaseLines,
    };
    await writeFile(path.join(ROOT, "eval/live/shipped", `${id}.bands.json`), `${JSON.stringify(out, null, 1)}\n`);
    console.log(`${id}: ${purchaseLines.length} purchase lines open on ${plan.open.length} of ${bands.length} rows, ${t.receipt.pii.length} personal data items closed, corners within ${round(r.geo.cornerCheckPx)}px`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
