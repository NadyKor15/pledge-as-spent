// The live agent's measure (rule 84): seven donor questions on the closed demo drive, asked through
// the debug page in Playwright's own Chromium, so AG Studio's loop, the delegation to its data agent,
// the book's tools and the guard all run for real. Three variants:
//   A  Nova Lite everywhere, the model picks every tool
//   B  Nova Pro for our `ledger` agent, Lite for Studio's `data` agent
//   C  Nova Lite, the book's code routes a question it recognises before the model's first turn
//
// Each run starts its own `next dev` (and stops it), so the limits are the server's, not a promise:
//   --live       real Nova through ../tools/p3/withp3.sh; needs --max-calls and --max-usd. The server
//                refuses any call past either (AGENT_DEV_MAX_CALLS for this run's lane, AGENT_DEV_MAX_USD
//                over all "agent-dev" entries, never above $0.20), and this script stops before a question
//                when the run has used either. Writes eval/agent/recorded/<mode>/Q*.json and
//                eval/agent/results-<mode>.json.
//   --sim        the simulated model (src/agent/simulate.ts): no AWS, no money; checks the plumbing and
//                counts turns. Writes eval/agent/recorded/sim-<mode>/ and eval/agent/results-sim-<mode>.json.
//   (neither)    replays eval/agent/recorded/<set>/ (default <mode>) and checks each replay matches.
//
//   npx tsx scripts/agent-measure.ts --mode C --live --max-calls 20 --max-usd 0.02
//   npx tsx scripts/agent-measure.ts --mode A --sim
//   npx tsx scripts/agent-measure.ts --mode A --set r1-lite

import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import closed from "../tests/fixtures/drives/closed.json";
import { evalQuestions, scoreAnswer } from "../eval/agent/questions";
import { novaUsd } from "../src/receipts/spend";
import type { DriveView } from "../src/ui/types";
import { runPage, type PageRun } from "./agent-browser";

const ROOT = path.resolve(__dirname, "..");
const CAMPAIGN = path.resolve(ROOT, "..");
const LEDGER = path.join(ROOT, "eval", "spend-ledger.jsonl");
const CALLS_LOG = path.join(CAMPAIGN, "docs", "nadya", "p3-agent", "live-calls.jsonl");
/** NM10, 06.11: every "agent-dev" entry together stays under this. */
const ALL_DEV_USD = 0.2;
const PER_QUESTION_CALLS = 10; // the server's own limit per question

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const mode = (arg("--mode") ?? "A").toUpperCase() as "A" | "B" | "C";
const live = process.argv.includes("--live");
const sim = process.argv.includes("--sim");
const only = arg("--only")?.split(",");
const port = Number(arg("--port") ?? "3415");
const maxCalls = Number(arg("--max-calls") ?? "NaN");
const maxUsd = Number(arg("--max-usd") ?? "NaN");
const set = arg("--set") ?? (sim ? `sim-${mode}` : mode);
const base = `http://localhost:${port}`;

if (!["A", "B", "C"].includes(mode)) throw new Error("--mode A|B|C");
if (live && sim) throw new Error("--live or --sim, not both");
if (live && !(maxCalls > 0 && maxUsd > 0)) throw new Error("--live needs --max-calls N and --max-usd X");

/** What all "agent-dev" entries of the file ledger add up to. */
function devSpent(): number {
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { what: string; usd: number })
    .filter((e) => e.what.startsWith("agent-dev"))
    .reduce((s, e) => s + e.usd, 0);
}

/** Calls the server booked for this run's lane. */
function laneCalls(lane: string): { n: number; usd: number } {
  if (!existsSync(CALLS_LOG)) return { n: 0, usd: 0 };
  const rows = readFileSync(CALLS_LOG, "utf8")
    .split("\n")
    .filter((l) => l.includes(`"lane":"${lane}"`))
    .map((l) => JSON.parse(l) as { usage?: { usdActual?: number | null; usdCeiling?: number } });
  return { n: rows.length, usd: rows.reduce((s, r) => s + (r.usage?.usdActual ?? r.usage?.usdCeiling ?? 0), 0) };
}

async function startServer(env: NodeJS.ProcessEnv, logFile: string): Promise<ChildProcess> {
  const out = openSync(logFile, "a");
  const cmd = live ? path.join(CAMPAIGN, "tools", "p3", "withp3.sh") : "npx";
  const args = live ? ["npx", "next", "dev", "-p", String(port)] : ["next", "dev", "-p", String(port)];
  const child = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(`${base}/debug/agent-spike?mode=script`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopServer(child);
  throw new Error(`next dev did not come up on ${port}; see ${logFile}`);
}

function stopServer(child: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // its own process group: next dev and its workers
  } catch {
    /* already gone */
  }
}

const usdOf = (turns: { response: { model?: string; usage?: { inputTokens: number; outputTokens: number } } }[]) =>
  turns.reduce((s, t) => (t.response.model && t.response.model !== "simulated" && t.response.usage ? s + novaUsd(t.response.model, t.response.usage.inputTokens, t.response.usage.outputTokens) : s), 0);

async function main() {
  const questions = evalQuestions(closed as unknown as DriveView).filter((q) => !only || only.includes(q.id));
  const recDir = path.join(ROOT, "eval", "agent", "recorded", set);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const lane = `measure-${mode}-${stamp}`;
  const routing = mode === "C" ? "code" : "model";
  const logFile = path.join(ROOT, ".data", `measure-${mode}-${stamp}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  if (live) {
    const ceiling = Math.min(ALL_DEV_USD, devSpent() + maxUsd);
    Object.assign(env, {
      LIVE_AGENT: "on",
      AGENT_DEV_LEDGER: LEDGER,
      AGENT_DEV_CALLS_LOG: CALLS_LOG,
      AGENT_DEV_LANE: lane,
      AGENT_DEV_MAX_CALLS: String(maxCalls),
      AGENT_DEV_MAX_USD: ceiling.toFixed(6),
      AGENT_QUESTIONS_PER_HOUR: "100",
      AGENT_QUESTIONS_PER_DAY: "200",
      AGENT_QUESTIONS_PER_DAY_ALL: "400",
      AGENT_MODEL_LEDGER: mode === "B" ? "pro" : "lite",
      AGENT_MODEL_DATA: "lite",
    });
    console.log(`live ${mode}: lane ${lane}, at most ${maxCalls} calls and $${maxUsd} (all agent-dev entries under $${ceiling.toFixed(4)}; now $${devSpent().toFixed(6)})`);
  } else if (!sim && !existsSync(recDir)) {
    throw new Error(`no recordings in ${recDir}`);
  }

  const server = await startServer(env, logFile);
  const browser = await chromium.launch();
  const rows: Record<string, unknown>[] = [];
  try {
    for (const q of questions) {
      if (live) {
        const used = laneCalls(lane);
        if (used.n >= maxCalls || used.usd >= maxUsd) {
          console.log(`stop: this run used ${used.n} calls, $${used.usd.toFixed(6)}`);
          break;
        }
        if (used.n + PER_QUESTION_CALLS > maxCalls) console.log(`note: ${maxCalls - used.n} calls left; the server stops this question at the run's limit`);
      }
      const page = live ? "live" : sim ? "sim" : "recorded";
      const url = `${base}/debug/agent-spike?mode=${page}&set=${encodeURIComponent(set)}&q=${q.id}&route=${routing}&auto=1`;
      const r: PageRun = await runPage(url, { browser, timeoutMs: 300_000 });
      const a = r.state.answer;
      const turns = r.turns as { agentId: string; response: { model?: string; usage?: { inputTokens: number; outputTokens: number } } }[];
      const s = scoreAnswer(q, { text: a?.text ?? r.state.message ?? "", retried: a?.retried ?? false, replaced: a?.replaced ?? false, delegated: a?.delegated ?? [] });
      const row = {
        ...s,
        correct: s.correct && r.phase === "answered",
        phase: r.phase,
        routed: (a as { routed?: string | null } | null)?.routed ?? null,
        calls: turns.length,
        ledgerCalls: turns.filter((t) => t.agentId === "ledger").length,
        usd: Number(usdOf(turns).toFixed(6)),
        text: a?.text ?? r.state.message ?? "",
        errors: r.errors,
      };
      if (live || sim) {
        mkdirSync(recDir, { recursive: true });
        const rec = { id: q.id, mode, routing, question: q.text, locale: q.locale, recordedAt: new Date().toISOString(), models: [...new Set(turns.map((t) => t.response.model).filter(Boolean))], phase: r.phase, message: r.state.message, answer: a, turns: r.turns, toolRuns: r.toolRuns, score: row };
        writeFileSync(path.join(recDir, `${q.id}.json`), JSON.stringify(rec, null, 2) + "\n");
      } else {
        const rec = JSON.parse(readFileSync(path.join(recDir, `${q.id}.json`), "utf8")) as { answer: { text: string } | null; phase: string };
        Object.assign(row, { replay: rec.phase === r.phase && (rec.answer?.text ?? "") === (a?.text ?? "") ? "same" : `DIFFERS: recorded ${rec.phase} "${rec.answer?.text}"` });
      }
      rows.push(row);
      console.log(`${q.id} ${row.correct ? "RIGHT" : "WRONG"} phase=${r.phase} routed=${row.routed} calls=${row.calls} $${row.usd} delegated=${s.delegated} guard=${s.guardFired} missing=${s.missing.join("|")} extra=${s.extra.join("|")} errors=${r.errors.length}${"replay" in row ? ` replay=${(row as { replay: string }).replay}` : ""}\n   ${row.text}`);
      if (live && r.phase === "limit") {
        console.log("stop: the server refused (limit, budget or this run's ceiling)");
        break;
      }
    }
  } finally {
    await browser.close();
    stopServer(server);
  }
  const right = rows.filter((r) => r.correct).length;
  const calls = rows.reduce((s, r) => s + (r.calls as number), 0);
  const usd = rows.reduce((s, r) => s + (r.usd as number), 0);
  const summary = { mode, routing, source: live ? "live" : sim ? "simulated" : `replay of ${set}`, at: new Date().toISOString(), right, of: rows.length, calls, usd: Number(usd.toFixed(6)), avgCalls: rows.length ? Number((calls / rows.length).toFixed(2)) : 0, avgUsd: rows.length ? Number((usd / rows.length).toFixed(6)) : 0, lane: live ? lane : null, serverCalls: live ? laneCalls(lane) : null, rows };
  if (live || sim) writeFileSync(path.join(ROOT, "eval", "agent", `results-${set}.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(`\n${mode} (${summary.source}): RIGHT ${right} of ${rows.length}; calls ${calls} (avg ${summary.avgCalls}); $${summary.usd} (avg $${summary.avgUsd})${live ? `; server booked ${JSON.stringify(summary.serverCalls)}; all agent-dev now $${devSpent().toFixed(6)}` : ""}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
