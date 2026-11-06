import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { TEXT } from "../../src/agent/i18n";

// The chat of the live agent, end to end in the browser: Studio's agent loop, the book's tools, the
// guard, the widget and the narrowed book all run for real. The server's two agent routes are answered
// here: /api/agent/question with an id or a limit, /api/agent/turn with the model turns Nova Lite gave
// in the live measure of 06.11 (eval/agent/recorded/r1-lite/Q1.json), or with made-up ones.

interface Turn {
  agentId: "ledger" | "data";
  response: { output: unknown[]; status: string; usage?: unknown; model?: string };
}

const Q1 = JSON.parse(readFileSync(path.resolve(__dirname, "../../eval/agent/recorded/r1-lite/Q1.json"), "utf8")) as { question: string; turns: Turn[] };

const message = (text: string) => ({ id: `m_${Math.random()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });

/** Serves model turns in order, per agent; `hold` keeps the next turn waiting until released. */
function turns(page: Page, list: { agentId: string; output: unknown[] }[]) {
  const queue = { ledger: list.filter((t) => t.agentId === "ledger"), data: list.filter((t) => t.agentId === "data") } as Record<string, { output: unknown[] }[]>;
  const seen: string[] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  const api = {
    seen,
    holdNext() {
      hold = new Promise((r) => (release = r));
    },
    release: () => release(),
  };
  void page.route("**/api/agent/turn", async (route: Route) => {
    const body = route.request().postDataJSON() as { agentId: string; questionId: string };
    seen.push(`${body.agentId}:${body.questionId}`);
    if (hold) {
      const h = hold;
      hold = null;
      await h;
    }
    const next = queue[body.agentId]?.shift();
    if (!next) return route.fulfill({ status: 502, json: { error: "model_failed", message: "No more recorded turns." } });
    await route.fulfill({ json: { id: "r", status: "completed", usage: { inputTokens: 1, outputTokens: 1 }, model: "recorded", output: next.output } });
  });
  return api;
}

let asked = 0;
async function questions(page: Page, answer: "ok" | { status: number; json: unknown } = "ok") {
  await page.route("**/api/agent/question", (route) => (answer === "ok" ? route.fulfill({ status: 201, json: { questionId: `e2e-question-${++asked}` } }) : route.fulfill(answer)));
}

async function open(page: Page) {
  await page.goto("/debug/agent-spike?mode=live&route=model");
  await expect.poll(() => page.evaluate(() => (window.__agentDebug?.state as (() => { ready: boolean }) | undefined)?.().ready ?? false), { timeout: 120_000 }).toBe(true);
}

async function ask(page: Page, text: string) {
  await page.getByTestId("ask-input").fill(text);
  await page.getByTestId("ask-send").click();
}

test("a question gets an answer with checked chips, and the book narrows to the donor's lines", async ({ page }) => {
  await questions(page);
  const served = turns(page, Q1.turns.map((t) => ({ agentId: t.agentId, output: t.response.output })));
  await open(page);
  await ask(page, Q1.question);

  const answer = page.getByTestId("ask-answer");
  // Each confirmed figure is a chip with a ✓ inside the sentence.
  await expect(answer).toContainText("Your ✓$30.00 hold paid ✓$21.45 for Diapers size M");
  await expect(page.getByTestId("ask-chip")).toHaveCount(7);
  await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
  await expect(page.getByTestId("dbg-narrow")).toContainText("Narrowed by the assistant: Mark · Columbus");
  await expect(page.getByTestId("dbg-book").locator("tbody tr")).toHaveCount(3);
  // The tool ran in the browser for real: its turn came back to the model, and the question id went with each turn.
  expect(served.seen).toEqual(["ledger:e2e-question-1", "ledger:e2e-question-1"]);

  await page.getByTestId("ask-chip").filter({ hasText: "$10.89" }).click();
  await expect(page.getByTestId("dbg-narrow")).toContainText("$10.89");
  await expect(page.getByTestId("dbg-book").locator("tbody tr")).toHaveCount(2); // line 5: Mark's share and the match's
});

test("a made-up figure never reaches the reader: asked once more, then \"I can't confirm\"", async ({ page }) => {
  await questions(page);
  const served = turns(page, [
    { agentId: "ledger", output: [message("Your hold paid $21.47 for diapers.")] },
    { agentId: "ledger", output: [message("Your hold paid $21.47, as I said.")] },
  ]);
  await open(page);
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-answer")).toHaveText(TEXT.cannotConfirm.en);
  await expect(page.getByTestId("ask-checked")).toContainText("not shown");
  await expect(page.getByText("21.47")).toHaveCount(0);
  expect(served.seen).toHaveLength(2);
});

test("out of questions is a sentence, not an error; so is a budget refusal mid-question", async ({ page }) => {
  await questions(page, { status: 429, json: { error: "agent_daily", message: TEXT.limit.en, limit: true } });
  await open(page);
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-note")).toHaveText(TEXT.limit.en);
  await expect(page.getByRole("button", { name: "Ask again" })).toHaveCount(0);
  expect(await page.evaluate(() => (window.__agentDebug!.state as () => { phase: string })().phase)).toBe("limit");

  await page.unroute("**/api/agent/question");
  await questions(page);
  await page.route("**/api/agent/turn", (route) => route.fulfill({ status: 429, json: { error: "agent_budget", message: TEXT.budget.en, limit: true } }));
  await ask(page, "Why was a line refused?");
  await expect(page.getByTestId("ask-note")).toHaveText(TEXT.budget.en);
  expect(await page.evaluate(() => (window.__agentDebug!.state as () => { phase: string })().phase)).toBe("limit");
});

test("Studio rebuilt in the middle of an answer: \"ask again\", and asking again answers", async ({ page }) => {
  await questions(page);
  const recorded = Q1.turns.map((t) => ({ agentId: t.agentId, output: t.response.output }));
  const served = turns(page, [...recorded, ...recorded]);
  await open(page);
  served.holdNext();
  await ask(page, Q1.question);
  await expect.poll(() => served.seen.length).toBe(1);
  await page.getByTestId("dbg-remount").click();
  await expect(page.getByTestId("ask-note")).toContainText(TEXT.interrupted.en);
  served.release();

  await expect.poll(() => page.evaluate(() => (window.__agentDebug!.state as () => { ready: boolean })().ready)).toBe(true);
  await page.getByRole("button", { name: "Ask again" }).click();
  await expect(page.getByTestId("ask-answer")).toContainText("Your ✓$30.00 hold paid ✓$21.45");
  await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
});
