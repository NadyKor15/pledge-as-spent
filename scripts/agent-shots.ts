// Screenshots of the chat's states on the debug page, no model involved:
// quick questions answered by the book's code (EN, and JA for Yuki), the guard replacing a made-up
// figure, Studio rebuilt mid-answer, the day's questions used up, and the phone width.
// npx tsx scripts/agent-shots.ts <base> <dir>

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [base = "http://localhost:3412", dir = "."] = process.argv.slice(2);

async function open(page: Page, query: string) {
  await page.goto(`${base}/debug/agent-spike?${query}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => (window.__agentDebug?.state as (() => { ready: boolean }) | undefined)?.().ready === true, null, { timeout: 120_000 });
}

const phase = (page: Page, phases: string[]) =>
  page.waitForFunction((ps) => ps.includes((window.__agentDebug!.state as () => { phase: string })().phase), phases, { timeout: 60_000 });

async function shot(page: Page, name: string, width: number) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const box = await page.locator("main").boundingBox();
  await page.screenshot({ path: path.join(dir, `${name}.png`), clip: { x: 0, y: 0, width, height: Math.min(box?.height ?? 900, 1100) } });
}

async function main() {
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const notes: Record<string, unknown> = {};
  const run = async (name: string, width: number, fn: (p: Page) => Promise<void>) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await fn(page);
      await shot(page, name, width);
      notes[name] = { phase: await page.evaluate(() => (window.__agentDebug!.state as () => { phase: string })().phase), text: await page.locator('[data-testid="ask-answer"], [data-testid="ask-note"]').first().textContent().catch(() => null), checked: await page.locator('[data-testid="ask-checked"]').textContent().catch(() => null), errors };
    } finally {
      await page.close();
    }
  };

  await run("code-money-en", 1440, async (p) => {
    await open(p, "mode=script");
    await p.click('[data-testid="ask-starter-money"]');
    await p.getByRole("button", { name: "Mark · Columbus" }).click();
    await phase(p, ["answered"]);
  });
  await run("code-paypal-ja", 1440, async (p) => {
    await open(p, "mode=script&lang=ja");
    await p.click('[data-testid="ask-starter-paypal"]');
    await p.getByRole("button", { name: "Yuki · Osaka" }).click();
    await phase(p, ["answered"]);
  });
  await run("code-refused-de", 1440, async (p) => {
    await open(p, "mode=script&lang=de");
    await p.click('[data-testid="ask-starter-refused"]');
    await phase(p, ["answered"]);
  });
  await run("guard-cannot-confirm", 1440, async (p) => {
    await open(p, "mode=script&bad=1&auto=1");
    await phase(p, ["cannot", "answered", "error"]);
  });
  await run("rebuilt-ask-again", 1440, async (p) => {
    await open(p, "mode=script");
    await p.evaluate(() => (window.__agentDebug!.ask as (t: string) => void)("I'm Mark from Columbus. What did my money buy?"));
    await p.waitForTimeout(150);
    await p.click('[data-testid="dbg-remount"]');
    await phase(p, ["interrupted"]);
  });
  await run("limit-de", 1440, async (p) => {
    await open(p, "mode=script&limit=1&lang=de&auto=1&q=Q6");
    await phase(p, ["limit"]);
  });
  await run("Q1-phone", 390, async (p) => {
    await open(p, "mode=recorded&q=Q1&auto=1");
    await phase(p, ["answered"]);
  });
  await browser.close();
  writeFileSync(path.join(dir, "states.json"), JSON.stringify(notes, null, 2) + "\n");
  console.log(JSON.stringify(notes, null, 2));
}

void main();
