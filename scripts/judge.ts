// npm run judge: every claim of the README's "Judge it in 90 seconds" table, checked by the tests that prove it.
// Needs no keys and no network: Postgres is PGlite in memory, PayPal is answered by the recorded live sandbox run and a
// stand-in, and receipts are read from saved answers. Runs on a fresh clone after `npm ci`. Exit 0 when every claim
// holds, 1 otherwise. The claims and their tests: scripts/judge-claims.ts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAIMS, type ClaimTest } from "./judge-claims";

interface Assertion {
  title: string;
  fullName: string;
  status: string;
  failureMessages?: string[];
}
interface Report {
  success?: boolean;
  testResults: { name: string; status: string; message?: string; assertionResults: Assertion[] }[];
}

const ROOT = process.cwd();
const started = Date.now();
const files = [...new Set(CLAIMS.flatMap((c) => c.tests.map((t) => t.file)))];
const missing = files.filter((f) => !existsSync(path.join(ROOT, f)));

// The judge's run must not depend on the machine: no switches of the hosted demo, no keys that could reach a live service.
const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(REBIND_ENABLED|RENEW_ENABLED|VOLUNTEER_INVITES|DONOR_RULES|NEXT_PUBLIC_.*|PAYPAL_.*|META_.*|DATABASE_URL|READING_PIPELINE|READ_META_ALLOWED|LIVE_AGENT|AGENT_META_ALLOWED|TELEGRAM_.*)$/.test(k)) delete env[k];
}

const dir = mkdtempSync(path.join(tmpdir(), "pledge-judge-"));
const out = path.join(dir, "vitest.json");
const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
// A judge's laptop may be slower than ours: wider time limits change nothing the tests check.
const limits = ["--testTimeout=60000", "--hookTimeout=60000"];
const run = existsSync(vitest)
  ? spawnSync(process.execPath, [vitest, "run", ...files.filter((f) => !missing.includes(f)), ...limits, "--reporter=json", `--outputFile=${out}`], { cwd: ROOT, env, encoding: "utf8" })
  : null;
const report: Report | null = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Report) : null;
rmSync(dir, { recursive: true, force: true });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log("Pledge-as-Spent · npm run judge");
console.log("The README's claims, each checked by its tests. No keys, no network: PayPal answers recorded from the live sandbox run, Postgres in memory.\n");

if (!run || !report) {
  console.log(!run ? "FAIL: vitest is not installed here; run `npm ci` first." : "FAIL: the tests did not run.");
  if (run) console.log((run.stderr || run.stdout || "").split("\n").slice(-20).join("\n"));
  process.exit(1);
}

const byFile = new Map(report.testResults.map((r) => [path.relative(ROOT, r.name).split(path.sep).join("/"), r]));
const tested = (t: ClaimTest): { found: Assertion[]; lost: string[] } => {
  const all = byFile.get(t.file)?.assertionResults ?? [];
  if (!t.titles) return { found: all, lost: all.length ? [] : [`${t.file}: no tests ran`] };
  const found = all.filter((a) => t.titles!.some((x) => a.title.startsWith(x)));
  return { found, lost: t.titles.filter((x) => !all.some((a) => a.title.startsWith(x))).map((x) => `${t.file}: no test "${x}…"`) };
};

let held = 0;
let counted = 0;
for (const c of CLAIMS) {
  const parts = c.tests.map(tested);
  const found = parts.flatMap((p) => p.found);
  const lost = parts.flatMap((p) => p.lost);
  const failed = found.filter((a) => a.status !== "passed");
  const ok = lost.length === 0 && failed.length === 0 && found.length > 0;
  if (ok) held++;
  counted += found.length;
  console.log(`${ok ? "✓" : "✗"} ${c.claim} · ${found.length} ${found.length === 1 ? "test" : "tests"}`);
  console.log(`    ${[...new Set(c.tests.map((t) => t.file))].join(", ")}`);
  if (c.note) console.log(`    ${c.note}`);
  for (const l of lost) console.log(`    missing: ${l}`);
  for (const a of failed) console.log(`    failed: ${a.fullName}${a.failureMessages?.[0] ? ` — ${a.failureMessages[0].split("\n")[0]}` : ""}`);
}

// Every test in these files must pass, not only the ones a claim names.
const others = report.testResults.flatMap((r) => r.assertionResults).filter((a) => a.status === "failed");
const broken = report.testResults.filter((r) => r.status === "failed" && r.assertionResults.length === 0);
const pass = held === CLAIMS.length && others.length === 0 && broken.length === 0 && missing.length === 0;
if (others.length) console.log(`\nOther failing tests in these files: ${others.map((a) => a.fullName).join("; ")}`);
for (const b of broken) console.log(`\nA test file did not load: ${path.relative(ROOT, b.name)} — ${(b.message ?? "").split("\n")[0]}`);
for (const m of missing) console.log(`\nMissing test file: ${m}`);
const total = report.testResults.reduce((s, r) => s + r.assertionResults.length, 0);
console.log(`\n${pass ? "PASS" : "FAIL"}: ${held} of ${CLAIMS.length} claims hold; ${counted} tests name a claim, ${total} tests ran in ${files.length} files, in ${seconds} s.`);
console.log("Every test of the repository: npm test");
process.exit(pass ? 0 : 1);
