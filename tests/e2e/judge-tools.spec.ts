import { expect, test, type Page } from "@playwright/test";

// The judge's own tools, on the real Next build with recorded sandbox answers (tests/e2e/server.ts): "Ask PayPal
// yourself" on the Ledger and on a donor's statement, "Try to cheat the receipt", and the landing page's ways in.
// No request leaves the machine: PayPal's answers are the recorded run's (tests/fixtures/paypal/app-e2e and -reads).

async function openDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Sample receipt, captures confirmed, drive closed: every PayPal object of the drive exists and is settled. */
async function finishedDrive(page: Page): Promise<string> {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await expect(async () => {
    await page.getByRole("button", { name: /^(Capture now|Check PayPal)$/ }).click();
    await expect(page.locator(".co-capDone")).toContainText("PayPal captured", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByRole("button", { name: "Close drive" }).click();
  await page.getByRole("button", { name: "Yes, close the drive" }).click();
  await expect(page.getByRole("link", { name: "See where the money went" })).toBeVisible({ timeout: 45_000 });
  return driveId;
}

test("Ask PayPal yourself on the Ledger: 9 of 9 answered by PayPal, each next to the book, with PayPal's JSON", async ({ page }) => {
  const driveId = await finishedDrive(page);
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/paypal-check")) asked.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto(`/drive/${driveId}?as=ledger`);
  await page.getByRole("button", { name: "Ask PayPal yourself" }).click();
  const dialog = page.locator("dialog.pc-dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("paypal-check-sum")).toHaveText("9 of 9 objects answered by PayPal · 9 agree with our book", { timeout: 20_000 });
  await expect(dialog).toContainText("Answered by PayPal sandbox through this app’s read-only calls.");
  await expect(dialog.locator(".pc-row[data-verdict]")).toHaveCount(9);
  await expect(dialog.locator('.pc-row[data-verdict="agrees"]')).toHaveCount(9);
  await expect(dialog.locator('.pc-row[data-kind="authorization"]').first()).toContainText("VOIDED");
  await expect(dialog.locator('.pc-row[data-kind="payout"]')).toContainText("SUCCESS");
  await expect(dialog.locator('.pc-row[data-kind="payout"]')).toContainText("¥10,448");
  // Each hold's end date, PayPal's expiration_time, beside the book's: four holds, four the same.
  await expect(dialog.getByTestId("paypal-check-ends")).toHaveCount(4);
  await expect(dialog.locator('[data-testid="paypal-check-ends"][data-expiry="agrees"]')).toHaveCount(4);
  await expect(dialog.getByTestId("paypal-check-ends").first()).toContainText("End date PayPal set for this hold: 2026-11-21 15:49:13 UTC");
  await expect(dialog.getByTestId("paypal-check-ends").first()).toContainText("our book: the same date");
  // PayPal's own answer, as it came, with the sandbox accounts hidden.
  const capture = dialog.locator('.pc-row[data-kind="capture"] .pc-json').first();
  await capture.locator("summary").click();
  await expect(capture.locator("pre")).toBeVisible();
  await expect(capture.locator("pre")).toContainText('"status": "COMPLETED"');
  for (const pre of await dialog.locator(".pc-json pre").all()) await expect(pre).not.toContainText(/@(business|personal)\.example\.com/);
  await expect(dialog.getByRole("link", { name: "All answers as JSON" })).toHaveAttribute("href", `/api/drives/${driveId}/paypal-check`);
  expect(asked).toEqual([`GET /api/drives/${driveId}/paypal-check`]);
  await dialog.locator(".pc-close").click();
  await expect(page.locator("dialog.pc-dialog[open]")).toHaveCount(0);
});

test("Ask PayPal yourself in German on the Ledger", async ({ page }) => {
  const driveId = await finishedDrive(page);
  await page.goto(`/drive/${driveId}?as=ledger&lang=de`);
  await page.getByRole("button", { name: "PayPal selbst fragen" }).click();
  await expect(page.locator("dialog.pc-dialog[open]").getByTestId("paypal-check-sum")).toHaveText("9 von 9 Objekten von PayPal beantwortet · 9 stimmen mit unserem Buch überein", { timeout: 20_000 });
});

test("a donor's statement asks PayPal about their own hold first, then the whole drive", async ({ page }) => {
  const driveId = await finishedDrive(page);
  await page.goto(`/pledge/${driveId}.water`);
  // The hold is over: the day PayPal answered its void, from the journal, before anyone asks PayPal.
  await expect(page.getByTestId("statement-vanish")).toHaveText(/^PayPal voided this hold on \d{1,2} [A-Z][a-z]{2} \d{4}: nothing more can be charged from it\.$/);
  await page.getByTestId("statement-ask-paypal").click();
  const dialog = page.locator("dialog.pc-dialog[open]");
  await expect(dialog.getByTestId("paypal-check-sum")).toHaveText("3 of 3 objects answered by PayPal · 3 agree with our book", { timeout: 20_000 });
  await expect(dialog.locator(".pc-row[data-verdict]")).toHaveCount(3);
  await expect(dialog.locator(".pc-row[data-verdict]").first()).toContainText("Lena");
  await expect(page.getByTestId("statement-vanish")).toContainText("PayPal confirms: VOIDED, 2026-10-23 15:49:46 UTC.");
  await dialog.getByRole("button", { name: "Show all 9 objects of this drive" }).click();
  await expect(dialog.getByTestId("paypal-check-sum")).toHaveText("9 of 9 objects answered by PayPal · 9 agree with our book");
});

test("what if we vanish: a live hold's statement names the day PayPal ends it, and PayPal confirms that day", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/pledge/${driveId}.water`);
  const line = page.getByTestId("statement-vanish");
  await expect(line).toHaveText("If Pledge-as-Spent disappears today, PayPal ends this hold by 21 Nov 2026, and nothing more can be charged after that.");
  await expect(page.getByRole("button", { name: "Withdraw pledge" })).toBeVisible();
  await page.getByTestId("statement-ask-paypal").click();
  await expect(page.locator("dialog.pc-dialog[open]").getByTestId("paypal-check-ends").first()).toContainText("our book: the same date", { timeout: 20_000 });
  await page.locator("dialog.pc-dialog[open] .pc-close").click();
  // The recorded run's hold answers are its final ones (VOIDED): PayPal is ahead of this live book, and says so.
  await expect(line).toContainText("PayPal now reports this hold VOIDED: nothing more can be charged from it.");
});

test("try to cheat the receipt: every forgery costs donors nothing, and the honest water on the same receipt is paid", async ({ page }) => {
  await page.goto("/cheat");
  await expect(page.getByRole("heading", { name: "Try to cheat the receipt" })).toBeVisible();
  await expect(page.locator(".ch-card")).toHaveCount(5);
  for (const id of ["pre-disaster", "duplicate", "out-of-zone", "edited-total", "forbidden-items"]) {
    await page.locator(`.ch-card[data-forgery="${id}"]`).click();
    // The previous result stays (dimmed) while this one runs: wait for this one's.
    await expect(page.locator(".ch-out")).toHaveAttribute("data-shown", id);
    await expect(page.getByTestId("cheat-score")).toContainText("Charged to donors for forged lines");
    await expect(page.locator(".ch-score-sum")).toHaveText("€0.00 · $0.00 · ¥0");
    await expect(page.locator(".ch-honesty")).toContainText("Recorded reading — no model call.");
  }
  // The last one picked: beer, cigarettes and a gift card refused line by line, the two lines of water paid.
  await expect(page.locator('.ch-line[data-outcome="paid"]')).toHaveCount(2);
  await expect(page.locator('.ch-line[data-outcome="refused"]')).toHaveCount(5);
  await expect(page.locator(".ch-score-honest")).toContainText("Honest lines on the same receipt pass and are paid");
  await page.locator('.ch-card[data-forgery="duplicate"]').click();
  await expect(page.locator(".ch-out")).toHaveAttribute("data-shown", "duplicate");
  await expect(page.locator('.ch-line[data-outcome="blocked"]')).toHaveCount(11);
  await expect(page.locator(".ch-flags")).toContainText("already uploaded");
});

test("the cheat page and the dialog fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/cheat");
  await page.locator('.ch-card[data-forgery="edited-total"]').click();
  await expect(page.locator(".ch-score-sum")).toHaveText("€0.00 · $0.00 · ¥0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

const FORGERY_IDS = ["pre-disaster", "duplicate", "out-of-zone", "edited-total", "forbidden-items"];

test.describe("the cheat page on a touch phone, 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap on each card picks that card, in order and back again", async ({ page }) => {
    await page.goto("/cheat");
    for (const id of [...FORGERY_IDS, ...FORGERY_IDS.slice().reverse(), "pre-disaster", "forbidden-items", "pre-disaster"]) {
      await page.locator(`.ch-card[data-forgery="${id}"]`).tap();
      await expect(page.locator('.ch-card[aria-pressed="true"]')).toHaveAttribute("data-forgery", id);
      await expect(page.locator(".ch-out")).toHaveAttribute("data-shown", id);
    }
  });

  test("the cards stay under the finger while the next result runs", async ({ page }) => {
    await page.goto("/cheat");
    await page.locator('.ch-card[data-forgery="forbidden-items"]').tap();
    await expect(page.locator(".ch-out")).toHaveAttribute("data-shown", "forbidden-items");
    // Hold the next answer back, to look at the page while the checks run.
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    await page.route((url) => url.pathname === "/api/cheat", async (route) => {
      await held;
      await route.continue();
    });
    const card = page.locator('.ch-card[data-forgery="edited-total"]');
    await card.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const before = await card.evaluate((e) => Math.round(e.getBoundingClientRect().top));
    await card.tap();
    await expect(page.locator(".ch-out.ch-stale")).toHaveCount(1);
    const during = await card.evaluate((e) => Math.round(e.getBoundingClientRect().top));
    expect(Math.abs(during - before)).toBeLessThanOrEqual(1);
    // A second tap during the wait lands where the finger is.
    await page.locator('.ch-card[data-forgery="out-of-zone"]').tap();
    await expect(page.locator('.ch-card[aria-pressed="true"]')).toHaveAttribute("data-forgery", "out-of-zone");
    release();
    await expect(page.locator(".ch-out")).toHaveAttribute("data-shown", "out-of-zone");
    await expect(page.locator(".ch-flags")).toContainText("outside the drive zone");
  });
});

/** The dialog's distance from each edge of the window. */
async function dialogGaps(page: Page) {
  const dialog = page.locator("dialog.pc-dialog[open]");
  await expect(dialog.locator(".pc-again")).toBeEnabled({ timeout: 20_000 });
  return dialog.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: innerWidth - r.right, top: r.top, bottom: innerHeight - r.bottom };
  });
}

test("Ask PayPal yourself opens in the middle of the window at 1440", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=ledger`);
  await page.getByRole("button", { name: "Ask PayPal yourself" }).first().click();
  const g = await dialogGaps(page);
  expect(g.left).toBeGreaterThan(100);
  expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(1);
  expect(g.top).toBeGreaterThan(0);
  expect(Math.abs(g.top - g.bottom)).toBeLessThanOrEqual(1);
});

test.describe("Ask PayPal yourself on a phone, 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the dialog is as wide as the phone less an even margin, in the middle", async ({ page }) => {
    const driveId = await openDemo(page);
    await page.goto(`/drive/${driveId}?as=ledger`);
    await page.getByRole("button", { name: "Ask PayPal yourself" }).first().tap();
    const g = await dialogGaps(page);
    for (const side of [g.left, g.right]) {
      expect(side).toBeGreaterThanOrEqual(8);
      expect(side).toBeLessThanOrEqual(16);
    }
    expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.top - g.bottom)).toBeLessThanOrEqual(1);
  });
});

test("the landing page leads to the cheat page; the Florida drive stays hidden unless switched on", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".ld-judge").getByRole("link", { name: "Try to cheat the receipt" })).toHaveAttribute("href", "/cheat");
  await expect(page.locator(".ld-judge")).toContainText("Ask PayPal yourself");
  await expect(page.getByRole("button", { name: "Open the Florida drive" })).toHaveCount(0);
});
