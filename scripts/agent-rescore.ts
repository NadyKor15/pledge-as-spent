// Scores a saved measure again with the current scorer (eval/agent/questions.ts), from the answers it kept:
// no model, no browser. The run's own score stays as `rightAtRun`; `right` and each row become the current
// scorer's, with `rescoredAt` and `rescoredBy` saying when and with which commit's scorer.
//
//   npx tsx scripts/agent-rescore.ts eval/agent/results-D.json

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import closed from "../tests/fixtures/drives/closed.json";
import { evalQuestions, scoreAnswer } from "../eval/agent/questions";
import type { DriveView } from "../src/ui/types";

interface Row {
  id: string;
  correct: boolean;
  guardFired: boolean;
  delegated: boolean;
  text: string;
  [k: string]: unknown;
}

interface Results {
  right: number;
  of: number;
  rows: Row[];
  rightAtRun?: number;
  rescoredAt?: string;
  rescoredBy?: string;
  [k: string]: unknown;
}

const file = process.argv[2];
if (!file) throw new Error("usage: npx tsx scripts/agent-rescore.ts <results-X.json>");
const results = JSON.parse(readFileSync(file, "utf8")) as Results;
const questions = evalQuestions(closed as unknown as DriveView);
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

const rows = results.rows.map((r) => {
  const q = questions.find((x) => x.id === r.id);
  if (!q) throw new Error(`${r.id}: no such question in eval/agent/questions.ts`);
  // The run kept whether the check stepped in, not which way: either way the answer is not right.
  const s = scoreAnswer(q, { text: r.text, retried: r.guardFired, replaced: false, delegated: r.delegated ? ["(delegated)"] : [] });
  if (s.correct !== r.correct) console.log(`${r.id}: ${r.correct ? "RIGHT" : "WRONG"} -> ${s.correct ? "RIGHT" : "WRONG"} missing=${s.missing.join("|")} extra=${s.extra.join("|")} words=${s.missingWords.join("|")}`);
  return { ...r, ...s };
});

const out: Results = {
  ...results,
  rightAtRun: results.rightAtRun ?? results.right,
  right: rows.filter((r) => r.correct).length,
  rescoredAt: new Date().toISOString(),
  rescoredBy: `scripts/agent-rescore.ts, scorer of commit ${commit}`,
  rows,
};
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`${file}: right ${out.rightAtRun} at the run -> ${out.right} of ${out.of} now`);
