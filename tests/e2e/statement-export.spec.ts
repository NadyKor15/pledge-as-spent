import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { readZip } from "../../src/ui/statement/zip";
import type { StatementView } from "../../src/ui/types";

// The donor's statement leaves the page two ways: a workbook built in the browser and a printable A4 page.
// Both are checked on a real drive (sample receipt, PayPal captures from the recorded sandbox), against the API's own statement.

const OUT = process.env.EXPORT_OUT ?? path.join(__dirname, "../../tmp/statement-export");

async function driveWithCaptures(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  const driveId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await expect(async () => {
    await page.getByRole("button", { name: /^(Capture now|Check PayPal)$/ }).click();
    await expect(page.locator(".co-capDone")).toContainText("PayPal captured", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  return driveId;
}

const statementOf = async (page: Page, pledge: string) => (await (await page.request.get(`/api/pledges/${pledge}/statement`)).json()) as StatementView;

test("Download my statement (.xlsx) gives the statement the API holds, to the cent, with PayPal ids as text", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const pledge = `${await driveWithCaptures(page)}.water`;
  const api = await statementOf(page, pledge);
  expect(api.statement.rows.length).toBeGreaterThan(0);

  await page.goto(`/pledge/${pledge}`);
  await expect(page.getByTestId("statement-xlsx")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("statement-xlsx").click()]);
  expect(download.suggestedFilename()).toBe(`statement-${pledge}.xlsx`);
  const file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);

  const parts = new Map(readZip(new Uint8Array(readFileSync(file))).map((f) => [f.name, f]));
  expect([...parts.values()].every((f) => f.crcOk)).toBe(true);
  const sheet = new TextDecoder().decode(parts.get("xl/worksheets/sheet1.xml")!.data);
  for (const row of api.statement.rows) {
    if (row.captureId) expect(sheet).toContain(`<t xml:space="preserve">${row.captureId}</t>`);
    expect(sheet).toContain(`<v>${row.share.minor / 100}</v>`);
  }
  expect(sheet).toContain(`<v>${api.statement.totals.charged / 100}</v>`);
  expect(sheet).toContain(api.statement.balance.authorizationId!);
  // The title is the screens' name for the drive, not the raw API title.
  expect(sheet).toContain("Kitasora Community Shelter — Earthquake relief");
});

test("the print page is the statement on A4: the same rows, no controls in print, a PDF that is more than a blank page", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const pledge = `${await driveWithCaptures(page)}.water`;
  const api = await statementOf(page, pledge);

  await page.goto(`/pledge/${pledge}`);
  await page.getByTestId("statement-pdf").click({ trial: true });
  expect(await page.getByTestId("statement-pdf").getAttribute("href")).toBe(`/pledge/${pledge}/print`);

  await page.goto(`/pledge/${pledge}/print`);
  const sheet = page.getByTestId("statement-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("tbody tr").first()).toBeVisible();
  // Rows of the first table (what was bought); the totals table is the second.
  await expect(sheet.locator("table").first().locator("tbody tr")).toHaveCount(api.statement.rows.length);
  for (const row of api.statement.rows) if (row.captureId) await expect(sheet).toContainText(row.captureId);
  await expect(sheet).toContainText("Kitasora Community Shelter — Earthquake relief");

  await expect(page.getByTestId("print-statement")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("print-statement")).toBeHidden();
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, path: path.join(OUT, `statement-${pledge}.pdf`) });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  // The page rule applies only while the print page is on screen.
  const pageRule = () => page.evaluate(() => [...document.head.querySelectorAll("style")].some((s) => s.textContent?.includes("@page")));
  expect(await pageRule()).toBe(true);
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("link", { name: "Back to the statement" }).click(); // client-side navigation: the document stays, so a leftover rule would stay too
  await expect(page.getByTestId("statement-xlsx")).toBeVisible();
  expect(await pageRule()).toBe(false);
});
