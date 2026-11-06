import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import closedJson from "../../tests/fixtures/drives/closed.json";
import { evalQuestions, scoreAnswer } from "../../eval/agent/questions";
import type { DriveView } from "@/ui/types";
import { factsFromLedgerResult, factsFromQueryResult, type ToolRun } from "./facts";
import { checkAnswer } from "./guard";
import type { Fact } from "./types";

// The measure (rule 84) on the recorded live runs of 06.11 (Nova Lite, eval/agent/recorded/Q*.json):
// the numbers below are what the agent actually answered; re-recording changes them on purpose.

const closed = closedJson as unknown as DriveView;
const DIR = path.resolve(__dirname, "../../eval/agent/recorded/r1-lite");
interface Recording {
  id: string;
  phase: string;
  answer: { text: string; retried: boolean; replaced: boolean; delegated: string[]; raw: string[] } | null;
  toolRuns: ToolRun[];
}
const recordings = readdirSync(DIR)
  .filter((f) => /^Q\d\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Recording);
const factsOf = (r: Recording): Fact[] =>
  r.toolRuns.flatMap((t) => (!t.ok ? [] : t.name.startsWith("ledger_") ? factsFromLedgerResult(t.result) : t.name === "execute_query" ? factsFromQueryResult(t.result, "JPY") : []));

describe("the measure on recorded Nova Lite answers", () => {
  it("all seven questions were recorded", () => {
    expect(recordings.map((r) => r.id).sort()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
  });

  it("right answers: Q1, Q2, Q4 — 3 of 7", () => {
    const qs = evalQuestions(closed);
    const right = recordings
      .filter((r) => {
        const q = qs.find((x) => x.id === r.id)!;
        const a = r.answer!;
        return r.phase === "answered" && scoreAnswer(q, { text: a.text, retried: a.retried, replaced: a.replaced, delegated: a.delegated }).correct;
      })
      .map((r) => r.id)
      .sort();
    expect(right).toEqual(["Q1", "Q2", "Q4"]);
  });

  it("every recorded final answer states only figures the recorded tool results returned", () => {
    for (const r of recordings) expect({ id: r.id, unmatched: checkAnswer(r.answer!.text, factsOf(r)).unmatched.map((c) => c.raw) }).toEqual({ id: r.id, unmatched: [] });
  });

  it("Q5: the guard confirms ¥3,000 is in the book — and the measure, not the guard, finds it is the wrong row", () => {
    const q5 = recordings.find((r) => r.id === "Q5")!;
    expect(checkAnswer(q5.answer!.text, factsOf(q5)).ok).toBe(true);
    const s = scoreAnswer(evalQuestions(closed).find((x) => x.id === "Q5")!, { ...q5.answer!, delegated: q5.answer!.delegated });
    expect(s).toMatchObject({ correct: false, missing: ["JPY 1486"], extra: ["¥3,000"], delegated: true });
  });

  it("scoring is strict both ways: a right Q1 with an extra made-up figure is wrong", () => {
    const q1 = evalQuestions(closed).find((x) => x.id === "Q1")!;
    const good = recordings.find((r) => r.id === "Q1")!.answer!.text;
    expect(scoreAnswer(q1, { text: good, retried: false, replaced: false }).correct).toBe(true);
    expect(scoreAnswer(q1, { text: `${good} You also gave $4.00.`, retried: false, replaced: false }).correct).toBe(false);
    expect(scoreAnswer(q1, { text: good, retried: true, replaced: false }).correct).toBe(false);
  });
});

describe("the guard on real Nova Lite output from the live runs (06.11)", () => {
  it('"$1486.00" for a yen sum: blocked (Q5, first run)', () => {
    const facts = factsFromQueryResult(JSON.stringify({ success: true, response: "", data: { result: [{ "Sum of Share": 1486, Need: "Water 2 L" }] } }), "JPY");
    expect(checkAnswer("The sum of the book's Share field for the water need is $1486.00.", facts).ok).toBe(false);
    expect(checkAnswer("The sum of the book's Share field for the water need is ¥1,486.", facts).ok).toBe(true);
  });

  it("a total the data agent added up itself: blocked (Q5, second run: rows per item, ¥1,486 only in its summary)", () => {
    const rows = [
      { Item: "Natural water from Kitasora 2L", "Sum of Share": 798 },
      { Item: "Melted snow water 2L", "Sum of Share": 472 },
      { Item: "Mineral water", "Sum of Share": 216 },
    ];
    const facts = factsFromQueryResult(JSON.stringify({ success: true, response: "", data: { result: rows } }), "JPY");
    expect(checkAnswer("The total amount that went to water across all donors is ¥1,486.", facts).ok).toBe(false);
  });
});
