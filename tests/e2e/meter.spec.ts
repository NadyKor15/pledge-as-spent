import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { DriveView, Hold } from "../../src/ui/types";

// The shelter card's money line on an OPEN drive is one line, at 1440 and at 390, in EN, DE and JA: a judge sees the
// open drive live and in the video. Measured in the browser: the line's height is one line-height and nothing
// is cut. Runs on the open fixture after PayPal took the first water line (all three tones), no network.

const ROOT = path.resolve(__dirname, "../..");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(ROOT, `tests/fixtures/drives/${name}.json`), "utf8")) as DriveView;

function openThreeTones(): DriveView {
  const v = fixture("open");
  const water = v.ledger.filter((r) => (r.kind === "donor_share" || r.kind === "match_share") && r.needId === "water");
  const first = Math.min(...water.map((r) => r.lineNo));
  for (const r of water.filter((x) => x.lineNo === first)) {
    r.status = "captured";
    const h = v.holds.find((x) => x.pledgeId === r.pledgeId) as Hold;
    h.accrued -= r.amount ?? 0;
    h.captured += r.amount ?? 0;
  }
  return v;
}

async function openLedger(page: Page, view: DriveView, lang: string) {
  await page.route(`**/api/drives/${view.drive.id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(view) }));
  await page.goto(`/drive/${view.drive.id}?as=ledger&lang=${lang}`);
  await expect(page.locator(".lg-shelter .nm-money").first()).toBeVisible({ timeout: 90_000 });
}

/** Each money line: its height in line-heights, and whether its text is wider than its box. */
const measure = (page: Page) =>
  page.locator(".lg-shelter .nm-money").evaluateAll((els) =>
    els.map((e) => {
      const lh = parseFloat(getComputedStyle(e).lineHeight);
      return { text: e.textContent, lines: Math.round(e.getBoundingClientRect().height / lh), cut: e.scrollWidth > e.clientWidth + 1 };
    }),
  );

for (const [label, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
  test.describe(`open drive at ${label}`, () => {
    test.use({ viewport: { width, height } });
    for (const lang of ["en", "de", "ja"]) {
      test(`${lang}: every need's money line is one line, nothing cut`, async ({ page }) => {
        await openLedger(page, openThreeTones(), lang);
        const lines = await measure(page);
        expect(lines).toHaveLength(3);
        for (const l of lines) expect(l, l.text ?? "").toEqual({ text: l.text, lines: 1, cut: false });
        // The card's list has room for all three needs: no scrolling on the open drive at 1440.
        if (width === 1440) expect(await page.locator(".lg-shelter ul").evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
      });
    }

    // Two holds in one currency: "on 2 holds". (Two currencies on one need, "€X · $Y on 2 holds", do not fit 390 in one
    // line: an open question, not tested here.)
    for (const lang of ["en", "de", "ja"]) {
      test(`${lang}: two donors' holds on one need, one currency: still one line`, async ({ page }) => {
        const v = openThreeTones();
        const lena = v.holds.find((h) => h.donorName.startsWith("Lena")) as Hold;
        v.holds.push({ ...lena, pledgeId: `${lena.pledgeId}-second`, donorName: "Anna (Hamburg)" });
        await openLedger(page, v, lang);
        const lines = await measure(page);
        expect(lines[0].text).toMatch(/2/);
        expect(lines[0]).toEqual({ text: lines[0].text, lines: 1, cut: false });
      });
    }
  });
}
