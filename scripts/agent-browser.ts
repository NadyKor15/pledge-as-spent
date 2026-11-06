// Drives the agent's debug page (/debug/agent-spike) in Playwright's own Chromium: asks one question,
// waits for the answer, returns what happened (state, turns, tool runs) and can take a screenshot.
// CLI, against a local `next dev`: npx tsx scripts/agent-browser.ts <url> <out.json> [shot.png] [--remount-after-ms N] [--phone]

import { chromium, type Browser } from "@playwright/test";
import { writeFileSync } from "node:fs";

export interface PageRun {
  phase: string;
  errors: string[];
  mode: string;
  q: string;
  locale: string;
  question: string;
  state: {
    phase: string;
    message: string | null;
    answer: { text: string; retried: boolean; replaced: boolean; delegated: string[]; raw: string[]; source: string; lineKeys: string[] } | null;
  };
  turns: unknown[];
  toolRuns: { agentId: string; name: string; args: unknown; ok: boolean; result: string }[];
  facts: unknown[];
  narrowed: string | null;
  chips: string[];
  checked: string | null;
}

export async function runPage(url: string, o: { shot?: string; remountAfterMs?: number | null; width?: number; browser?: Browser; timeoutMs?: number } = {}): Promise<PageRun> {
  const width = o.width ?? 1440;
  const browser = o.browser ?? (await chromium.launch());
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // AG Studio prints its trial-licence banner as console errors; those are not failures.
    if (m.type() === "error" && !/\*{8}|License|trial|watermark|info@ag-grid\.com/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => (window.__agentDebug?.state as (() => { ready: boolean }) | undefined)?.().ready === true, null, { timeout: 120_000 });
    if (o.remountAfterMs != null) {
      await page.evaluate(() => (window.__agentDebug!.ask as (t: string) => void)(window.__agentDebug!.question as string));
      await page.waitForTimeout(o.remountAfterMs);
      await page.click('[data-testid="dbg-remount"]');
    }
    const phase = await page
      .waitForFunction(
        () => {
          const s = (window.__agentDebug?.state as (() => { phase: string }) | undefined)?.();
          return s && ["answered", "cannot", "limit", "error", "interrupted"].includes(s.phase) ? s.phase : false;
        },
        null,
        { timeout: o.timeoutMs ?? 240_000 },
      )
      .then((h) => h.jsonValue() as Promise<string>)
      .catch(() => "timeout");
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => {
      const d = window.__agentDebug!;
      return {
        mode: d.mode,
        q: d.q,
        locale: d.locale,
        question: d.question,
        state: (d.state as () => unknown)(),
        turns: d.turns,
        toolRuns: (d.toolRuns as () => unknown)(),
        facts: (d.facts as () => unknown)(),
        narrowed: document.querySelector('[data-testid="dbg-narrow"]')?.textContent ?? null,
        chips: [...document.querySelectorAll('[data-testid="ask-chip"]')].map((x) => x.textContent ?? ""),
        checked: document.querySelector('[data-testid="ask-checked"]')?.textContent ?? null,
      };
    });
    if (o.shot) {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      const box = await page.locator("main").boundingBox();
      await page.screenshot({ path: o.shot, clip: box ? { x: 0, y: 0, width, height: Math.min(box.height, 1400) } : undefined });
    }
    return { phase, errors, ...(result as Omit<PageRun, "phase" | "errors">) };
  } finally {
    await page.close();
    if (!o.browser) await browser.close();
  }
}

if (process.argv[1]?.endsWith("agent-browser.ts")) {
  const [url, out, shot] = process.argv.slice(2);
  const i = process.argv.indexOf("--remount-after-ms");
  void runPage(url, { shot, remountAfterMs: i > 0 ? Number(process.argv[i + 1]) : null, width: process.argv.includes("--phone") ? 390 : 1440 }).then((r) => {
    writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(JSON.stringify({ phase: r.phase, errors: r.errors.length, chips: r.chips, checked: r.checked, narrowed: r.narrowed }));
  });
}
