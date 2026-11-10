import { expect, test, type Locator, type Page } from "@playwright/test";

// The daily check with PayPal on the real Next build with recorded sandbox answers (tests/e2e/server.ts): the line
// under "Ask PayPal yourself" on the Ledger and in a donor's statement, before the first check and after the cron's.
// The recorded run answers a hold's GET with its last recorded state (VOIDED), so an open drive's held holds are
// "the book is behind PayPal": the check names each one instead of printing a clean line.

/** The cron's bearer secret: playwright.config.ts gives the server the same one. */
const SECRET = "e2e-reconcile-secret";

async function openDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** The line sits inside the Ledger's bottom line: it is never cut off by the widget around it. */
async function insideFooter(page: Page, line: Locator) {
  const foot = await page.locator(".lg-foot").boundingBox();
  const box = await line.boundingBox();
  expect(foot && box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(foot!.y - 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(foot!.y + foot!.height + 0.5);
  expect(box!.x).toBeGreaterThanOrEqual(foot!.x - 0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(foot!.x + foot!.width + 0.5);
}

/**
 * Everything else in the bottom line still fits in it with the new line there: the refusals, the rates, the links.
 * Only what is shown: the closed dialog of differences sits in the bottom line's markup but takes no room in it.
 */
async function footerFits(page: Page) {
  for (const part of await page.locator(".lg-foot > *").filter({ visible: true }).all()) await insideFooter(page, part);
  const shown = page.locator(".lg-foot p").filter({ visible: true });
  expect(await shown.count()).toBeGreaterThan(0);
  for (const p of await shown.all()) await insideFooter(page, p);
}

/** The element is what the browser shows at its own middle: not covered, not clipped away. */
async function onTop(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === node || node.contains(hit));
  });
}

test("the daily check with PayPal: not checked yet, then the cron's answer on the Ledger in three languages and in the statement, each difference named", async ({ page, request }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=ledger`);
  const line = page.getByTestId("reconcile-line");
  await expect(line).toHaveText("Not checked with PayPal yet");
  await expect(line).toHaveAttribute("data-state", "none");
  await insideFooter(page, line);

  // The cron's route wants its secret; the run asks PayPal with GETs only and keeps one row per drive.
  expect((await request.get("/api/cron/reconcile")).status()).toBe(401);
  expect((await request.get("/api/cron/reconcile", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
  const run = await request.get("/api/cron/reconcile", { headers: { authorization: `Bearer ${SECRET}` } });
  expect(run.status()).toBe(200);
  const report = (await run.json()) as { checked: { driveId: string; total: number; answered: number; agrees: number; differences: number }[] };
  expect(report.checked.find((x) => x.driveId === driveId)).toEqual({ driveId, total: 4, answered: 4, agrees: 0, differences: 4 });
  const kept = await (await request.get(`/api/drives/${driveId}/reconcile`)).json();
  expect(kept.last).toMatchObject({ driveId, total: 4, answered: 4, agrees: 0 });
  expect(JSON.stringify(kept)).not.toMatch(/@|example\.com|debug|access_token/);

  await page.reload();
  await expect(line).toHaveAttribute("data-state", "differs");
  // The line itself (its list is in the same box, closed): textContent would read both.
  const text = line.locator(".rc-text");
  await expect(text).toHaveText(/^Checked with PayPal · [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC · 4 objects · 4 differences$/);
  await expect(text.locator("time")).toHaveAttribute("datetime", kept.last.askedAt);
  await insideFooter(page, line);
  await footerFits(page);
  // The list opens in the top layer and names every hold with the book's word and PayPal's; each item is really on
  // screen (not under the report, not clipped by the widget): the point at its middle is the item itself.
  await line.locator("button.rc-open").click();
  const dialog = page.getByTestId("reconcile-dialog");
  await expect(dialog).toBeVisible();
  const items = dialog.getByTestId("reconcile-differences").locator("li");
  await expect(items).toHaveCount(4);
  for (const li of await items.all()) {
    await expect(li).toHaveText(/^Hold \S+: the book is behind PayPal · our book held \S+ · PayPal VOIDED \S+$/);
    expect(await onTop(li)).toBe(true);
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/drive/${driveId}?as=ledger&lang=de`);
  await expect(text).toHaveText(/^Mit PayPal abgeglichen · .+ UTC · 4 Objekte · 4 Abweichungen$/);
  await insideFooter(page, line);
  await footerFits(page);
  await page.goto(`/drive/${driveId}?as=ledger&lang=ja`);
  await expect(text).toHaveText(/^PayPal と照合済み · .+ UTC · 対象 4 件 · 相違 4 件$/);
  await insideFooter(page, line);
  await footerFits(page);

  // The donor's statement: the same line under its own "Ask PayPal yourself", the list in the card.
  await page.goto(`/pledge/${driveId}.water`);
  const st = page.getByTestId("reconcile-line");
  await expect(st.locator(".rc-text")).toHaveText(/^Checked with PayPal · .+ UTC · 4 objects · 4 differences$/);
  await expect(page.getByTestId("reconcile-differences").locator("li")).toHaveCount(4);
  const button = await page.getByTestId("statement-ask-paypal").boundingBox();
  const sb = await st.boundingBox();
  expect(sb!.y).toBeGreaterThan(button!.y);
});

test.describe("the daily check's line on a phone, 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("before and after the check it stays inside the Ledger's bottom line, in all three languages", async ({ page, request }) => {
    const driveId = await openDemo(page);
    for (const checked of [false, true]) {
      if (checked) expect((await request.get("/api/cron/reconcile", { headers: { authorization: `Bearer ${SECRET}` } })).status()).toBe(200);
      for (const lang of ["en", "de", "ja"]) {
        await page.goto(`/drive/${driveId}?as=ledger&lang=${lang}`);
        const line = page.getByTestId("reconcile-line");
        await expect(line).toHaveAttribute("data-state", checked ? "differs" : "none");
        await line.scrollIntoViewIfNeeded();
        await insideFooter(page, line);
        await footerFits(page);
      }
    }
  });
});
