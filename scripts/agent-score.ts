// Scores the recorded runs of the live agent (eval/agent/recorded/Q*.json) with eval/agent/questions.ts
// and writes eval/agent/results[-tag].json. No model, no browser: npx tsx scripts/agent-score.ts [--tag pro]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import closed from "../tests/fixtures/drives/closed.json";
import { evalQuestions, scoreAnswer } from "../eval/agent/questions";
import type { DriveView } from "../src/ui/types";

const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : undefined;
const ROOT = path.resolve(__dirname, "..");

interface Recording {
  phase: string;
  recordedAt: string;
  models: string[];
  answer: { text: string; retried: boolean; replaced: boolean; delegated: string[] } | null;
  message: string | null;
  turns: { agentId: string; request: { instructionsChars: number }; response: { usage?: { inputTokens: number; outputTokens: number } } }[];
}

const rows = [];
for (const q of evalQuestions(closed as unknown as DriveView)) {
  const file = path.join(ROOT, "eval", "agent", "recorded", `${q.id}${tag ? `-${tag}` : ""}.json`);
  if (!existsSync(file)) continue;
  const r = JSON.parse(readFileSync(file, "utf8")) as Recording;
  const a = r.answer;
  const s = scoreAnswer(q, { text: a?.text ?? r.message ?? "", retried: a?.retried ?? false, replaced: a?.replaced ?? false, delegated: a?.delegated ?? [] });
  const correct = s.correct && r.phase === "answered";
  const ledgerPrompt = r.turns.find((t) => t.agentId === "ledger")?.request.instructionsChars ?? null;
  rows.push({ ...s, correct, phase: r.phase, text: a?.text ?? r.message ?? "", recordedAt: r.recordedAt, models: r.models, calls: r.turns.length, ledgerPromptChars: ledgerPrompt, tokensIn: r.turns.reduce((n, t) => n + (t.response.usage?.inputTokens ?? 0), 0) });
}
const right = rows.filter((r) => r.correct).length;
writeFileSync(path.join(ROOT, "eval", "agent", `results${tag ? `-${tag}` : ""}.json`), JSON.stringify({ scoredAt: new Date().toISOString(), right, of: rows.length, rows }, null, 2) + "\n");
for (const r of rows) console.log(`${r.id} ${r.correct ? "RIGHT" : "WRONG"} calls=${r.calls} prompt=${r.ledgerPromptChars} missing=${r.missing.join("|")} extra=${r.extra.join("|")}\n   ${r.text}`);
console.log(`RIGHT ${right} of ${rows.length}`);
