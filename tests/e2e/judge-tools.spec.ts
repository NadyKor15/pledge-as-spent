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
  // PayPal's own answer, as it came, with the sandbox accounts hidden.
  await dialog.locator('.pc-row[data-kind="capture"] .pc-json summary').first().click();
  await expect(dialog.locator(".pc-json pre").first()).toContainText('"status": "COMPLETED"');
  await expect(dialog.locator(".pc-json pre").first()).not.toContainText("@business.example.com");
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
  await page.getByTestId("statement-ask-paypal").click();
  const dialog = page.locator("dialog.pc-dialog[open]");
  await expect(dialog.getByTestId("paypal-check-sum")).toHaveText("3 of 3 objects answered by PayPal · 3 agree with our book", { timeout: 20_000 });
  await expect(dialog.locator(".pc-row[data-verdict]")).toHaveCount(3);
  await expect(dialog.locator(".pc-row[data-verdict]").first()).toContainText("Lena");
  await dialog.getByRole("button", { name: "Show all 9 objects of this drive" }).click();
  await expect(dialog.getByTestId("paypal-check-sum")).toHaveText("9 of 9 objects answered by PayPal · 9 agree with our book");
});

test("try to cheat the receipt: every forgery costs donors nothing, and the honest water on the same receipt is paid", async ({ page }) => {
  await page.goto("/cheat");
  await expect(page.getByRole("heading", { name: "Try to cheat the receipt" })).toBeVisible();
  await expect(page.locator(".ch-card")).toHaveCount(5);
  for (const id of ["pre-disaster", "duplicate", "out-of-zone", "edited-total", "forbidden-items"]) {
    await page.locator(`.ch-card[data-forgery="${id}"]`).click();
    await expect(page.getByTestId("cheat-score")).toContainText("Charged to donors for forged lines");
    await expect(page.locator(".ch-score-sum")).toHaveText("€0.00 · $0.00 · ¥0");
    await expect(page.locator(".ch-honesty")).toContainText("Recorded reading — no model call.");
  }
  // The last one picked: beer, cigarettes and a gift card refused line by line, the two lines of water paid.
  await expect(page.locator('.ch-line[data-outcome="paid"]')).toHaveCount(2);
  await expect(page.locator('.ch-line[data-outcome="refused"]')).toHaveCount(5);
  await expect(page.locator(".ch-score-honest")).toContainText("Honest lines on the same receipt pass and are paid");
  await page.locator('.ch-card[data-forgery="duplicate"]').click();
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

test("the landing page leads to the cheat page; the Florida drive stays hidden unless switched on", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".ld-judge").getByRole("link", { name: "Try to cheat the receipt" })).toHaveAttribute("href", "/cheat");
  await expect(page.locator(".ld-judge")).toContainText("Ask PayPal yourself");
  await expect(page.getByRole("button", { name: "Open the Florida drive" })).toHaveCount(0);
});
