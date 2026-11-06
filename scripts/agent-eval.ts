// The live agent's measure (rule 84): seven donor questions on the closed demo drive, asked through
// the debug page in Playwright's Chromium, so AG Studio's loop, the delegation to its data agent,
// the book's tools and the guard all run for real.
//
// Live (costs money; dev server started through ../tools/p3/withp3.sh with LIVE_AGENT=on and the
// AGENT_DEV_* ledger, see eval/agent/README.md):
//   npx tsx scripts/agent-eval.ts --live --base http://localhost:3413 [--only Q1,Q5] [--tag pro]
//   -> eval/agent/recorded/<Q>[-tag].json and eval/agent/results[-tag].json
// Recorded (free; replays the model's recorded turns):
//   npx tsx scripts/agent-eval.ts --recorded --base http://localhost:3412 [--tag pro] [--shots <dir>]

import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import closed from "../tests/fixtures/drives/closed.json";
import { evalQuestions, scoreAnswer, type Score } from "../eval/agent/questions";
import type { DriveView } from "../src/ui/types";
import { runPage, type PageRun } from "./agent-browser";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const live = process.argv.includes("--live");
const base = arg("--base") ?? "http://localhost:3412";
const tag = arg("--tag");
const only = arg("--only")?.split(",");
const shots = arg("--shots");
const ROOT = path.resolve(__dirname, "..");
const REC = path.join(ROOT, "eval", "agent", "recorded");

const file = (id: string) => path.join(REC, `${id}${tag ? `-${tag}` : ""}.json`);

async function main() {
  mkdirSync(REC, { recursive: true });
  if (shots) mkdirSync(shots, { recursive: true });
  const questions = evalQuestions(closed as unknown as DriveView).filter((q) => !only || only.includes(q.id));
  const browser = await chromium.launch();
  const rows: (Score & { phase: string; text: string; replay?: string })[] = [];
  try {
    for (const q of questions) {
      if (!live && !existsSync(file(q.id))) {
        console.log(`${q.id}: no recording`);
        continue;
      }
      const qq = `${q.id}${tag ? `-${tag}` : ""}`;
      const url = `${base}/debug/agent-spike?mode=${live ? "live" : "recorded"}&q=${encodeURIComponent(qq)}&auto=1`;
      const r: PageRun = await runPage(url, { browser, shot: shots ? path.join(shots, `${qq}.png`) : undefined, timeoutMs: 300_000 });
      const a = r.state.answer;
      const score = scoreAnswer(q, { text: a?.text ?? r.state.message ?? "", retried: a?.retried ?? false, replaced: a?.replaced ?? false, delegated: a?.delegated ?? [] });
      const correct = score.correct && r.phase === "answered";
      const row = { ...score, correct, phase: r.phase, text: a?.text ?? r.state.message ?? "" };
      if (live) {
        writeFileSync(
          file(q.id),
          JSON.stringify(
            {
              id: q.id,
              question: q.text,
              locale: q.locale,
              recordedAt: new Date().toISOString(),
              models: [...new Set((r.turns as { response: { model?: string } }[]).map((t) => t.response.model).filter(Boolean))],
              phase: r.phase,
              message: r.state.message,
              answer: a,
              turns: r.turns,
              toolRuns: r.toolRuns,
              score: row,
              errors: r.errors,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        const rec = JSON.parse(readFileSync(file(q.id), "utf8")) as { answer: { text: string } | null; phase: string };
        (row as { replay?: string }).replay = rec.phase === r.phase && (rec.answer?.text ?? "") === (a?.text ?? "") ? "same" : `DIFFERS: recorded ${rec.phase} "${rec.answer?.text}"`;
      }
      rows.push(row);
      console.log(`${q.id} ${row.correct ? "RIGHT" : "WRONG"} phase=${r.phase} delegated=${row.delegated} guard=${row.guardFired} missing=${row.missing.join("|")} extra=${row.extra.join("|")} errors=${r.errors.length}${(row as { replay?: string }).replay ? ` replay=${(row as { replay?: string }).replay}` : ""}\n   ${row.text}`);
      if (live && r.phase === "limit") {
        console.log("Stopped: the server refused (limit or development ceiling).");
        break;
      }
    }
  } finally {
    await browser.close();
  }
  const right = rows.filter((r) => r.correct).length;
  console.log(`\nRIGHT ${right} of ${rows.length}`);
  if (live) writeFileSync(path.join(ROOT, "eval", "agent", `results${tag ? `-${tag}` : ""}.json`), JSON.stringify({ at: new Date().toISOString(), right, of: rows.length, rows }, null, 2) + "\n");
}

void main();
