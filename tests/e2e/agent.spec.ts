import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { TEXT } from "../../src/agent/i18n";
import type { DriveView } from "../../src/ui/types";
import { heroClosed } from "../fixtures/closed-hero";

// "Ask the book" on the Ledger page: the chat in the book's slot, over the book. The drive is the closed demo
// snapshot and the model's turns are the ones recorded in the live measure (eval/baseline-legacy/agent/recorded/A), or
// made up where a case needs it; the server's /api/agent routes are answered here. Everything between runs for
// real: AG Studio's agent loop, the book's tools, the guard, the widget, the book narrowed by the answer.

const ROOT = path.resolve(__dirname, "../..");
const SHOTS = process.env.AGENT_SHOTS ?? path.join(ROOT, "tmp/agent-shots");
mkdirSync(SHOTS, { recursive: true });

const fixture = () => JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/drives/closed.json"), "utf8")) as DriveView;
/** The published copy of the sample receipt: the photo closed to its purchase lines, as the reading makes it. */
const published = heroClosed();

interface Turn {
  agentId: string;
  response: { output: unknown[] };
}
const recorded = (q: string) => (JSON.parse(readFileSync(path.join(ROOT, `eval/baseline-legacy/agent/recorded/A/${q}.json`), "utf8")) as { question: string; turns: Turn[] });
const Q1 = recorded("Q1");
const turnsOf = (r: { turns: Turn[] }) => r.turns.map((t) => ({ agentId: t.agentId, output: t.response.output }));
const message = (text: string) => ({ id: `m_${Math.random()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
const call = (name: string, args: object) => ({ id: `fc_${Math.random()}`, kind: "output", type: "function_call", callId: `c_${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) });

/** Serves model turns in order, per agent; `holdNext` keeps the next one waiting until released. */
function model(page: Page, list: { agentId: string; output: unknown[] }[], label = "Meta Muse Spark") {
  const queue: Record<string, { output: unknown[] }[]> = { ledger: list.filter((t) => t.agentId === "ledger"), data: list.filter((t) => t.agentId === "data") };
  const seen: string[] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
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
    await route.fulfill({ json: { id: "r", status: "completed", usage: { inputTokens: 1, outputTokens: 1 }, model: "recorded", modelLabel: label, output: next.output } });
  });
  return {
    seen,
    holdNext() {
      hold = new Promise((r) => (release = r));
    },
    release: () => release(),
  };
}

let asked = 0;
const questions = (page: Page, answer: "ok" | { status: number; json: unknown } = "ok", label = "Meta Muse Spark") =>
  page.route("**/api/agent/question", (route) => (answer === "ok" ? route.fulfill({ status: 201, json: { questionId: `e2e-question-${++asked}`, model: label } }) : route.fulfill(answer)));

const errors: string[] = [];
async function openLedger(page: Page, query = "") {
  errors.length = 0;
  page.on("console", (m) => {
    if (m.type() === "error" && !/\*{8}|License|trial|watermark|info@ag-grid\.com/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const v = fixture();
  await page.route(`**/api/drives/${v.drive.id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(v) }));
  await page.route("**/api/receipts/*/image", (r) => r.fulfill({ contentType: "image/png", body: published }));
  await page.goto(`/drive/${v.drive.id}?as=ledger${query}`);
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("ask-widget")).toBeVisible();
  // The agent is attached to Studio once its thread is open.
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-testid=ask-widget]")?.getAttribute("data-ready")), { timeout: 60_000 }).toBe("true");
}

async function ask(page: Page, text: string) {
  await page.getByTestId("ask-input").fill(text);
  await page.getByTestId("ask-send").click();
}

const phase = (page: Page) => page.getByTestId("ask-widget").getAttribute("data-phase");

test("a question gets an answer with checked chips, and the book narrows to the donor's lines; no WebMCP, no line about it", async ({ page }) => {
  await questions(page);
  const served = model(page, turnsOf(Q1));
  await openLedger(page);
  await expect(page.getByTestId("ask-model")).toBeVisible();
  await expect(page.getByTestId("webmcp-badge")).toHaveCount(0);
  await expect(page.getByTestId("ask-model")).toHaveText(/^Meta Muse Spark · read-only/);
  await ask(page, Q1.question);
  const answer = page.getByTestId("ask-answer");
  await expect(answer).toContainText("Your ✓$30.00 hold paid ✓$21.45 for Diapers size M");
  await expect(page.getByTestId("ask-chip")).toHaveCount(7);
  await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
  await expect(page.locator(".lg-chip")).toHaveText(/^Narrowed by the assistant: Mark · Columbus/);
  await expect(page.locator(".ag-row.lg-focused")).toHaveCount(6); // lines 4, 5, 6: Mark's shares and the match's
  expect(served.seen).toEqual(["ledger:e2e-question-1", "ledger:e2e-question-1"]);
  await page.getByTestId("ask-chip").filter({ hasText: "$10.89" }).click();
  await expect(page.locator(".lg-chip")).toHaveText(/^Narrowed by the assistant: \$10\.89/);
  await expect(page.locator(".ag-row.lg-focused")).toHaveCount(2);
  await page.getByTestId("ask-widget").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, "ask-1440.png"), fullPage: false });
  expect(errors).toEqual([]);
});

test("a made-up figure never reaches the reader: asked once more, then \"I can't confirm\"", async ({ page }) => {
  await questions(page);
  const served = model(page, [
    { agentId: "ledger", output: [message("Your hold paid $21.47 for diapers.")] },
    { agentId: "ledger", output: [message("Your hold paid $21.47, as I said.")] },
  ]);
  await openLedger(page);
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-answer")).toHaveText(TEXT.cannotConfirm.en);
  await expect(page.getByTestId("ask-checked")).toContainText("not shown");
  await expect(page.getByTestId("ask-widget").getByText("21.47")).toHaveCount(0);
  expect(served.seen).toHaveLength(2);
});

test("out of questions is a sentence, not an error; so is the budget running out mid-question", async ({ page }) => {
  await questions(page, { status: 429, json: { error: "agent_daily", message: TEXT.limit.en, limit: true } });
  await openLedger(page);
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-note")).toHaveText(TEXT.limit.en);
  await expect(page.getByRole("button", { name: "Ask again" })).toHaveCount(0);
  expect(await phase(page)).toBe("limit");
  await page.unroute("**/api/agent/question");
  await questions(page);
  await page.route("**/api/agent/turn", (route) => route.fulfill({ status: 429, json: { error: "agent_budget", message: TEXT.budget.en, limit: true } }));
  await ask(page, "Why was a line refused?");
  await expect(page.getByTestId("ask-note")).toHaveText(TEXT.budget.en);
  expect(await phase(page)).toBe("limit");
});

test("the report rebuilt in the middle of an answer (the window resized): \"ask again\", and asking again answers", async ({ page }) => {
  await questions(page);
  const served = model(page, [...turnsOf(Q1), ...turnsOf(Q1)]);
  await openLedger(page);
  served.holdNext();
  await ask(page, Q1.question);
  await expect.poll(() => served.seen.length).toBe(1);
  await page.setViewportSize({ width: 1200, height: 860 }); // another scale: Studio is built again
  await expect(page.getByTestId("ask-note")).toContainText(TEXT.interrupted.en);
  served.release();
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-testid=ask-widget]")?.getAttribute("data-ready")), { timeout: 60_000 }).toBe("true");
  await page.getByRole("button", { name: "Ask again" }).click();
  await expect(page.getByTestId("ask-answer")).toContainText("Your ✓$30.00 hold paid ✓$21.45");
  await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
});

test("a sum across donors: the step names what Studio's data agent did in a fixed sentence, not the model's instructions", async ({ page }) => {
  const Q5 = recorded("Q5"); // the recorded delegation instructions here are a query's JSON ending in ">>"
  await questions(page);
  const served = model(page, turnsOf(Q5));
  await openLedger(page);
  await ask(page, Q5.question);
  await expect(page.getByTestId("ask-answer")).toContainText("✓¥1,486");
  await expect(page.getByTestId("ask-step")).toHaveText("Asked Studio's data agent to sum the book's Share by need");
  const widget = (await page.getByTestId("ask-widget").innerText()).replace(/\s+/g, " ");
  for (const raw of ["variant", "aggregation", ">>", "{", "exactly as the query"]) expect(widget).not.toContain(raw);
  expect(served.seen.map((s) => s.split(":")[0])).toEqual(["ledger", "data", "data", "ledger"]);
  expect(errors).toEqual([]);
});

test("\"Ask again\" pressed at once after the rebuild: it and Send wait for Studio, then the question is answered", async ({ page }) => {
  await questions(page);
  const served = model(page, [...turnsOf(Q1), ...turnsOf(Q1)]);
  await openLedger(page);
  // Every change of the chat while Studio is built again: is Studio ready, and are "Ask again" and Send enabled.
  await page.evaluate(() => {
    const w = window as unknown as { __askLog: { ready: string | null; again: boolean | null; send: boolean }[] };
    w.__askLog = [];
    const take = () => {
      const widget = document.querySelector("[data-testid=ask-widget]");
      const again = document.querySelector(".ask-again") as HTMLButtonElement | null;
      const send = document.querySelector("[data-testid=ask-send]") as HTMLButtonElement | null;
      if (widget && send) w.__askLog.push({ ready: widget.getAttribute("data-ready"), again: again ? !again.disabled : null, send: !send.disabled });
    };
    new MutationObserver(take).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "disabled"] });
  });
  served.holdNext();
  await ask(page, Q1.question);
  await expect.poll(() => served.seen.length).toBe(1);
  await page.getByTestId("ask-input").fill("a question typed while the report is rebuilt");
  await page.setViewportSize({ width: 1200, height: 860 }); // another scale: Studio is built again
  await expect(page.getByTestId("ask-note")).toContainText(TEXT.interrupted.en);
  served.release();
  await page.getByRole("button", { name: "Ask again" }).click(); // at once: the click waits for the button to be enabled
  await expect(page.getByTestId("ask-answer")).toContainText("Your ✓$30.00 hold paid ✓$21.45");
  const log = await page.evaluate(() => (window as unknown as { __askLog: { ready: string | null; again: boolean | null; send: boolean }[] }).__askLog);
  expect(log.some((x) => x.ready === "false")).toBe(true); // the rebuild was seen (the check below is not empty)
  expect(log.filter((x) => x.ready !== "true" && (x.again === true || x.send))).toEqual([]);
});

test("\"Ask about this line\" in a row's proof band asks the agent about that line", async ({ page }) => {
  await questions(page);
  const served = model(page, [
    { agentId: "ledger", output: [call("ledger_line", { line: "4" })] },
    { agentId: "ledger", output: [message("Line 4, soft kids diapers M, cost ¥2,596; Mark (Columbus) paid $8.58 of it in PayPal capture 5PE922386K0983923.")] },
  ]);
  await openLedger(page);
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await page.locator('.ag-row:has([data-row-key="demo-f372326129.r1:4/demo-f372326129.diapers"]) .lg-item-name').click();
  await page.getByRole("button", { name: "Ask about this line" }).click();
  await expect(page.getByTestId("ask-question")).toHaveText("What happened to line 4: what was bought, who paid for it, or why was it refused?");
  await expect(page.getByTestId("ask-answer")).toContainText("✓¥2,596");
  await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 3 of 3");
  expect(served.seen).toHaveLength(2);
});

test("the header's \"Ask the book ↓\" brings the chat into view from the first screen", async ({ page }) => {
  await questions(page);
  await openLedger(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const anchor = page.getByTestId("ask-anchor");
  await expect(anchor).toHaveText("Ask the book ↓");
  await expect(anchor).toBeInViewport();
  await anchor.click();
  await expect(page.getByTestId("ask-widget").getByRole("heading")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("ask-input")).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(/#ask-the-book$/);
});

test("in German the chat speaks German: quick question answered by the book's code, euro in the German form", async ({ page }) => {
  await questions(page);
  await openLedger(page);
  await page.getByRole("button", { name: "DE", exact: true }).click();
  await expect(page.getByTestId("ask-widget").getByRole("heading")).toHaveText("Frag das Buch");
  // The header over the book speaks German with it: the role tabs, the badge, the drive's name, the way to the chat.
  const nav = page.getByRole("navigation", { name: "Rolle" });
  await expect(nav.getByRole("link")).toHaveText(["Unterkunft", "Spender", "Helfer", "Koordination", "Buch"]);
  await expect(nav.getByRole("link", { name: "Buch" })).toHaveAttribute("href", /[?&]lang=de/);
  await expect(page.locator("header.hd-top")).toContainText("Fiktive Sammlung · PayPal-Sandbox");
  await expect(page.locator("header.hd-top")).toContainText("Kitasora Gemeinschaftsunterkunft");
  await expect(page.getByTestId("ask-anchor")).toHaveText("Frag das Buch ↓");
  await page.getByTestId("ask-starter-back").click();
  await page.getByTestId("ask-widget").getByRole("button", { name: "Lena · Berlin" }).click();
  await expect(page.getByTestId("ask-answer")).toContainText("✓15,42 €");
  await expect(page.getByTestId("ask-checked")).toContainText("Mit dem Buch abgeglichen");
  await expect(page.getByTestId("ask-model")).toHaveText(/^Meta Muse Spark · nur lesend/);
  await expect(page.getByTestId("webmcp-badge")).toHaveCount(0);
});

test("one model, named alone: Meta Muse Spark before and after it answered, no other model in the small print", async ({ page }) => {
  await questions(page, "ok", "Meta Muse Spark");
  model(page, turnsOf(Q1), "Meta Muse Spark");
  await openLedger(page);
  await expect(page.getByTestId("ask-model")).toHaveText("Meta Muse Spark · read-only · it cannot move money");
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-answer")).toContainText("✓$21.45");
  await expect(page.getByTestId("ask-model")).toHaveText("Meta Muse Spark · read-only · it cannot move money");
  await expect(page.getByTestId("ask-widget")).not.toContainText(/Nova|Amazon|falls back/);
});

test("Muse Spark failed twice on the server: the chat says the assistant is busy, in a sentence, not an error", async ({ page }) => {
  await questions(page);
  await page.route("**/api/agent/turn", (route) => route.fulfill({ status: 503, json: { error: "agent_busy", message: TEXT.busy.en, limit: true } }));
  await openLedger(page);
  await ask(page, Q1.question);
  await expect(page.getByTestId("ask-note")).toHaveText("The assistant is busy, please try again in a minute.");
  expect(await phase(page)).toBe("limit");
  await expect(page.getByTestId("ask-model")).toHaveText(/^Meta Muse Spark · read-only/);
  // The browser reports the 503 itself; no script error comes with it.
  expect(errors.filter((e) => !/Failed to load resource: .*503/.test(e))).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("390 px: the chat answers with chips and nothing spills sideways", async ({ page }) => {
    await questions(page);
    model(page, turnsOf(Q1));
    await openLedger(page);
    // The question box sits right under the quick questions: no empty band between them before anything is asked.
    const gap = await page.evaluate(() => {
      const starters = document.querySelector(".ask-starters")!.getBoundingClientRect();
      const input = document.querySelector("[data-testid=ask-input]")!.getBoundingClientRect();
      return input.top - starters.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(40);
    // And no empty band under the small print before the first question (it was about 330 px).
    const band = await page.evaluate(() => document.querySelector("[data-testid=ask-widget]")!.getBoundingClientRect().bottom - document.querySelector(".ask-foot")!.getBoundingClientRect().bottom);
    expect(band).toBeLessThan(90);
    await ask(page, Q1.question);
    await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
    // The answer scrolls inside the chat's area and is brought into view there.
    await expect(page.getByTestId("ask-question")).toBeVisible();
    expect(await page.evaluate(() => { const box = document.querySelector("[data-testid=ask-widget]")!.getBoundingClientRect(); const q = document.querySelector("[data-testid=ask-question]")!.getBoundingClientRect(); return q.top >= box.top && q.top < box.bottom; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.getByTestId("ask-widget").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "ask-390.png") });
  });

  test("390 px: \"The book\" on one line, the narrowing chip cut with an ellipsis, its × whole on screen and working", async ({ page }) => {
    await questions(page);
    model(page, turnsOf(Q1));
    await openLedger(page);
    await ask(page, Q1.question);
    await expect(page.getByTestId("ask-checked")).toHaveText("Checked against the book · 7 of 7");
    const chip = page.locator(".lg-chip");
    await expect(chip).toHaveText(/^Narrowed by the assistant: Mark · Columbus/);
    await chip.scrollIntoViewIfNeeded();
    const head = await page.evaluate(() => {
      const h2 = document.querySelector(".lg-book-head h2")!;
      const r = document.createRange();
      r.selectNodeContents(h2);
      const x = document.querySelector(".lg-chip button")!.getBoundingClientRect();
      const label = document.querySelector(".lg-chip-label") as HTMLElement | null;
      return { lines: r.getClientRects().length, xLeft: x.left, xRight: x.right, xWidth: x.width, cut: label ? label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === "ellipsis" : null };
    });
    expect(head.lines).toBe(1);
    expect(head.xWidth).toBeGreaterThanOrEqual(24);
    expect(head.xLeft).toBeGreaterThanOrEqual(0);
    expect(head.xRight).toBeLessThanOrEqual(390);
    expect(head.cut).toBe(true); // "Narrowed by the assistant: Mark · Columbus" does not fit next to "The book" at 390
    await page.screenshot({ path: path.join(SHOTS, "ask-390-chip.png") });
    await chip.getByRole("button", { name: "Show every line" }).click();
    await expect(page.locator(".lg-chip")).toHaveCount(0);
    await expect(page.locator(".ag-row.lg-focused")).toHaveCount(0);
  });
});
