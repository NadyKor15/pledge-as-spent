// Offline recount of the money on every recorded reading, before and after a change to the receipt checks.
//   npx tsx tools/eval/tax-recheck.ts [--was <git rev>] [--out <file.md>] [--json <file.json>]
// "Was" is src/receipts/checks.ts as it is in the given commit (default: HEAD), "now" is the working tree's. Both get
// the same readings and classifications: the Meta answers saved in eval/live/meta*, the shipped sample answer, the
// recorded readings, the /cheat forgeries, and the control drive's book for the sample. No model and no PayPal call:
// only code. For every line it prints what the line would charge (funded) or show (refused or held), and the receipt's
// flags; the table lists every line whose amount, outcome or flags differ.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Drive, Need } from "../../src/core/types";
import * as nowChecks from "../../src/receipts/checks";
import { receiptKey } from "../../src/receipts/recorded";
import { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { demoDrive } from "../../src/server/demo";
import { SCENARIOS, type Locale } from "../receipts/scenario";

type Checks = typeof nowChecks;

const ROOT = path.resolve(__dirname, "../..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const WAS = arg("--was") ?? "HEAD";

/** The checks module of a commit, its relative imports pointed at this tree's modules (which it shares unchanged). */
async function checksAt(rev: string): Promise<Checks> {
  const src = execFileSync("git", ["show", `${rev}:src/receipts/checks.ts`], { cwd: ROOT, encoding: "utf8" });
  const dir = path.join(ROOT, "src/receipts");
  const fixed = src.replace(/from "(\.{1,2}\/[^"]+)"/g, (_m, rel: string) => `from ${JSON.stringify(path.join(dir, rel))}`);
  const tmp = mkdtempSync(path.join(tmpdir(), "tax-recheck-"));
  const file = path.join(tmp, "checks.ts");
  writeFileSync(file, fixed);
  return (await import(pathToFileURL(file).href)) as Checks;
}

interface Case {
  source: string;
  receiptId: string;
  /** Each printed line's true tax rate from the receipt set's truth file, when the reading has the same lines. */
  trueRates?: (number | null)[];
  reading: ParsedReceipt;
  classifications: LineClassification[];
  drive: Drive;
  needs: Need[];
}

const kitasora = demoDrive("demo-recheck", "2026-11-03T00:00:00Z");
const localeOf = (id: string): Locale | null => (/-(ja|tr|es|en)-\d+$/.exec(id)?.[1] as Locale | undefined) ?? null;
const scenarioOf = (id: string) => {
  const l = localeOf(id);
  return l ? { drive: SCENARIOS[l].drive, needs: SCENARIOS[l].needs } : null;
};

const TRUTH_RATES = new Map<string, (number | null)[]>();
const SHA_TO_ID = new Map<string, string>();
for (const set of readdirSync(path.join(ROOT, "eval/receipts"), { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const d = path.join(ROOT, "eval/receipts", set.name);
  for (const f of readdirSync(d).filter((x) => x.endsWith(".truth.json"))) {
    const t = JSON.parse(readFileSync(path.join(d, f), "utf8"));
    SHA_TO_ID.set(t.image.sha256, t.id);
    TRUTH_RATES.set(t.id, (t.receipt.lines as { taxRateBp: number | null }[]).map((l) => l.taxRateBp));
  }
}
const withTruth = (c: Case): Case => {
  const t = TRUTH_RATES.get(c.receiptId);
  return t && t.length === c.reading.lines.length ? { ...c, trueRates: t } : c;
};

function cases(): Case[] {
  const out: Case[] = [];
  // Meta's saved answers: holdout-1 (three runs), holdout-2, the adversarial set and the sample's benchmark run.
  for (const dir of ["meta", "meta-fix", "meta-run2", "meta-h2"]) {
    const d = path.join(ROOT, "eval/live", dir);
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json")).sort()) {
      const x = JSON.parse(readFileSync(path.join(d, f), "utf8"));
      if (!x.reading || !x.classifications) continue;
      const sc = x.receiptId === "hero-ja-01" ? kitasora : scenarioOf(x.receiptId);
      if (!sc) continue;
      out.push({ source: `eval/live/${dir}`, receiptId: x.receiptId, reading: ParsedReceipt.parse(x.reading), classifications: LineClassification.array().parse(x.classifications), ...sc });
    }
  }
  // The sample as the demo serves it (cached:meta).
  const hero = JSON.parse(readFileSync(path.join(ROOT, "eval/live/shipped/hero-ja-01.meta.json"), "utf8"));
  out.push({ source: "eval/live/shipped", receiptId: "hero-ja-01", reading: ParsedReceipt.parse(hero.reading), classifications: LineClassification.array().parse(hero.classifications), ...kitasora });
  // The recorded readings (ground truth of the synthetic sets, and the Florida sample).
  const rec = JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")) as { readings: Record<string, unknown>; classifications: Record<string, unknown> };
  const idBySha = SHA_TO_ID;
  for (const [sha, raw] of Object.entries(rec.readings)) {
    const reading = ParsedReceipt.parse(raw);
    const id = idBySha.get(sha) ?? (reading.currency === "USD" ? "florida-sample" : sha.slice(0, 12));
    const sc = id === "florida-sample" ? demoDrive("demo-recheck-fl", "2026-11-03T00:00:00Z", "florida") : scenarioOf(id);
    const cl = recordedClassifications(rec.classifications, reading);
    if (!sc || !cl) continue;
    out.push({ source: "eval/receipts/recorded.json", receiptId: id, reading, classifications: cl, ...sc });
  }
  // The /cheat forgeries, on a fresh copy of the demo drive.
  const forgeries = JSON.parse(readFileSync(path.join(ROOT, "src/server/forgeries.json"), "utf8")) as { id: string; reading: unknown; labels: unknown }[];
  for (const f of forgeries) out.push({ source: "src/server/forgeries.json", receiptId: `cheat:${f.id}`, reading: ParsedReceipt.parse(f.reading), classifications: LineClassification.array().parse(f.labels), ...kitasora });
  return out.map(withTruth);
}

/**
 * What a line truly costs with its own tax, from the truth file's rates: the printed amount times (1 + rate), for a
 * funded line with the discounts that follow it. Null without a truth file or on a receipt with tax inside the prices.
 */
function trueAmount(c: Case, i: number, funded: boolean): string {
  if (!c.trueRates || c.reading.taxIncluded !== false) return "—";
  let above: number | null = null;
  const rates = c.reading.lines.map((l, k) => {
    const r = c.trueRates![k];
    if (l.amountMinor >= 0) above = r;
    return l.amountMinor < 0 && r === null ? above : r;
  });
  const idx = [i];
  if (funded) for (let k = i + 1; k < c.reading.lines.length && c.reading.lines[k].amountMinor < 0; k++) idx.push(k);
  const v = idx.reduce((t, k) => t + (c.reading.lines[k].amountMinor * (10000 + (rates[k] ?? 0))) / 10000, 0);
  return money(c.reading.currency, Math.round(v * 100) / 100, true);
}

/** Recorded classifications are kept by the reading's key (src/receipts/recorded.ts). */
function recordedClassifications(all: Record<string, unknown>, reading: ParsedReceipt): LineClassification[] | null {
  const key = receiptKey(reading);
  return Object.hasOwn(all, key) ? LineClassification.array().parse(all[key]) : null;
}

interface LineOut {
  lineNo: number;
  text: string;
  outcome: string;
  amount: number;
}

function run(checks: Checks, c: Case): { lines: LineOut[]; flags: string[] } {
  const res = checks.toFundableLines(c.reading, c.classifications, c.needs, c.drive, {}, { receiptId: c.receiptId });
  const split = (checks as Partial<Checks>).splitTax ? checks.splitTax(c.reading, c.classifications)?.shares : checks.allocateTax(c.reading);
  const tax = split ?? c.reading.lines.map(() => 0);
  const flags = checks.checkReceipt({ receipt: c.reading, drive: c.drive, classifications: c.classifications }).map((f) => f.code);
  const lines: LineOut[] = c.reading.lines.map((l, i) => {
    const f = res.fundable.find((x) => x.lineNo === l.lineNo);
    const r = res.rejected.find((x) => x.lineNo === l.lineNo);
    const shown = Math.max(0, l.amountMinor + (tax[i] ?? 0));
    if (f) return { lineNo: l.lineNo, text: l.translationEn || l.rawText, outcome: `funded ${f.needId}`, amount: f.amountBase };
    if (r) return { lineNo: l.lineNo, text: l.translationEn || l.rawText, outcome: `refused ${r.code}`, amount: shown };
    return { lineNo: l.lineNo, text: l.translationEn || l.rawText, outcome: l.amountMinor < 0 ? "discount" : "none", amount: l.amountMinor + (tax[i] ?? 0) };
  });
  return { lines, flags };
}

const money = (currency: string, minor: number, exact = false) =>
  currency === "JPY" ? `¥${minor.toLocaleString("en-US", { maximumFractionDigits: exact ? 2 : 0 })}` : `${currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `}${(minor / 100).toFixed(exact ? 4 : 2)}`;

async function main() {
  const was = await checksAt(WAS);
  const all = cases();
  const rows: string[] = [];
  const json: unknown[] = [];
  let changedLines = 0;
  let changedReceipts = 0;
  const deltaFunded: Record<string, number> = {};
  for (const c of all) {
    const a = run(was, c);
    const b = run(nowChecks, c);
    const flagsChanged = a.flags.join(",") !== b.flags.join(",");
    let any = false;
    for (let i = 0; i < a.lines.length; i++) {
      const x = a.lines[i];
      const y = b.lines[i];
      if (x.amount === y.amount && x.outcome === y.outcome) continue;
      any = true;
      changedLines++;
      const fundedDelta = (y.outcome.startsWith("funded") ? y.amount : 0) - (x.outcome.startsWith("funded") ? x.amount : 0);
      deltaFunded[c.reading.currency] = (deltaFunded[c.reading.currency] ?? 0) + fundedDelta;
      const rate = c.reading.lines[i].taxRateBp;
      rows.push(
        `| ${c.source} | ${c.receiptId} | ${x.lineNo} | ${x.text.replace(/\|/g, "/")} | ${rate === null ? "none" : `${rate / 100} %`} | ${x.outcome} ${money(c.reading.currency, x.amount)} | ${y.outcome} ${money(c.reading.currency, y.amount)} | ${trueAmount(c, i, y.outcome.startsWith("funded"))} | ${a.flags.join(", ") || "none"} → ${b.flags.join(", ") || "none"} |`,
      );
    }
    if (!any && flagsChanged) rows.push(`| ${c.source} | ${c.receiptId} | — | (no line changed) | | | | | ${a.flags.join(", ") || "none"} → ${b.flags.join(", ") || "none"} |`);
    if (any || flagsChanged) changedReceipts++;
    json.push({ source: c.source, receiptId: c.receiptId, currency: c.reading.currency, was: a, now: b });
  }

  // The control drive's book: the sample as funded on the hosted demo must come out the same.
  const control = JSON.parse(readFileSync(path.join(ROOT, "evidence/control-drive-20261109.json"), "utf8"));
  const heroCase = all.find((c) => c.source === "eval/live/shipped")!;
  const ledger = control.drive.ledger as { lineNo: number; base: number }[];
  const nowHero = run(nowChecks, heroCase);
  const wasHero = run(was, heroCase);
  const controlCheck = heroCase.reading.lines.map((l) => {
    const rows = ledger.filter((x) => x.lineNo === l.lineNo);
    const book = rows.length ? rows.reduce((t, x) => t + x.base, 0) : null;
    const n = nowHero.lines.find((x) => x.lineNo === l.lineNo)!;
    const w = wasHero.lines.find((x) => x.lineNo === l.lineNo)!;
    return { lineNo: l.lineNo, book, was: w.amount, now: n.amount };
  });

  const header = [
    `Recount of ${all.length} recorded receipts: checks of ${WAS} ("was") against the working tree ("now"). No model call.`,
    "",
    `Receipts with any change: ${changedReceipts}. Lines whose amount or outcome changed: ${changedLines}.`,
    `Change in funded money (now minus was), by currency: ${Object.entries(deltaFunded).map(([cur, d]) => `${cur} ${money(cur, d)}`).join(", ") || "none"}.`,
    "",
    "Columns: the rate the reading printed on the line; what the line charged (funded) or showed (refused) before and after;",
    "what it truly costs with its own tax by the receipt set's truth file (amount × (1 + its rate); a funded line with its discount).",
    "",
    "| Source | Receipt | Line | Item | Rate read | Was | Now | True cost | Flags was → now |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const md = [...header, ...rows, "", "Control drive (hosted demo, sample receipt): book amount per line against the recount.", "", "| Line | Book | Was | Now |", "|---|---|---|---|", ...controlCheck.map((x) => `| ${x.lineNo} | ${x.book ?? "—"} | ${x.was} | ${x.now} |`)].join("\n");
  const out = arg("--out");
  if (out) writeFileSync(out, `${md}\n`);
  const j = arg("--json");
  if (j) writeFileSync(j, JSON.stringify({ was: WAS, receipts: json, control: controlCheck }, null, 1));
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
