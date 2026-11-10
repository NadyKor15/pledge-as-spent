// Records the sample receipt's lines in German and Japanese once, so the showcase and every drive on the sample receipt
// show a donor's lines in their language with no model call (eval/receipts/translations.json, keyed by the printed line).
// Two Meta Muse Spark calls (de, ja), text only, each priced at its worst case before it is sent and settled after, in
// eval/meta-spend-ledger.jsonl with the prefix read-meta:translate: under the Meta reading's ceiling ($5 over every
// read-meta row). Without --live it only prints what it would send and the worst case.
//
//   npx tsx scripts/record-translations.ts                       dry run
//   VAULT_EGRESS_OK=api.meta.ai ../tools/p3/with-meta-nadya.sh npx tsx scripts/record-translations.ts --live

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { META_READ_MODEL } from "../src/receipts/meta";
import { PrefixJsonlSpendLedger, SpendCap, worstCaseUsd } from "../src/receipts/spend";
import { translateInput, translateInstructions, translateLines, TRANSLATE_MAX_OUTPUT, TRANSLATE_PREFIX, TRANSLATED, type LineToTranslate } from "../src/receipts/translate";
import { META_READ_CAP_MAX_USD } from "../src/server/spend";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "eval/receipts/translations.json");
const LEDGER = path.join(ROOT, "eval/meta-spend-ledger.jsonl");
const SHOWCASE = path.join(ROOT, "evidence/control-drive-20261109-810b24be50.json");

async function main() {
  const live = process.argv.includes("--live");
  // --lang de: record only that language (the others in the file stay as they are).
  const only = process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : null;
  const langs = TRANSLATED.filter((l) => !only || l === only);
  const view = JSON.parse(readFileSync(SHOWCASE, "utf8")).drive as { receipts: { id: string; lines: { lineNo: number; text: string; translationEn: string }[] }[] };
  const receipt = view.receipts[0];
  const lines: LineToTranslate[] = receipt.lines.map((l) => ({ lineNo: l.lineNo, printed: l.text.trim(), english: (l.translationEn ?? "").trim() || l.text.trim() }));
  const ledger = new PrefixJsonlSpendLedger(LEDGER, "read-meta");
  const before = await ledger.total();
  for (const lang of langs) {
    const lg = lang as "de" | "ja";
    const textChars = translateInstructions(lg).length + translateInput(lines).length;
    console.log(`${lang}: ${lines.length} lines, worst case $${worstCaseUsd(META_READ_MODEL, { textChars, toolSpecChars: 0, images: 0, maxTokens: TRANSLATE_MAX_OUTPUT }).toFixed(4)}`);
  }
  console.log(`read-meta spend so far: $${before.toFixed(4)} of $${META_READ_CAP_MAX_USD}`);
  if (!live) return console.log("dry run: nothing sent (--live to record)");
  const apiKey = process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error("META_MODEL_API_KEY is not set (run through tools/p3/with-meta-nadya.sh)");
  const cap = new SpendCap(ledger, META_READ_CAP_MAX_USD);
  const file = JSON.parse(readFileSync(OUT, "utf8")) as { lines: Record<string, Record<string, string>>; recordedAt: string | null };
  for (const lang of langs) {
    const lg = lang as "de" | "ja";
    const made = await translateLines({ apiKey, baseUrl: process.env.META_MODEL_API_BASE_URL, cap, prefix: TRANSLATE_PREFIX }, { what: `record ${receipt.id}`, lang: lg, lines });
    file.lines[lg] = Object.fromEntries(lines.map((l) => [l.printed, made.get(l.lineNo)!]));
    for (const l of lines) console.log(`  ${lang} ${l.lineNo}: ${l.printed} -> ${made.get(l.lineNo)}`);
  }
  file.recordedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n");
  const after = await ledger.total();
  console.log(`spent $${(after - before).toFixed(6)}; read-meta spend now $${after.toFixed(4)} of $${META_READ_CAP_MAX_USD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
