import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The Florida demo drive in a real browser (florida.config.ts: a build with NEXT_PUBLIC_FLORIDA_DEMO=on, PayPal answered
// by the stateful stand-in). Its real 2019 grocery receipt is offered by a button of its own, on the Volunteer's upload
// form and on the Coordinator's empty receipt panel; the checks hold it for a person as bought before the storm, and no
// money moves for it.

const REAL = "Try a real 2019 receipt";

async function open(page: Page, label: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: label }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

interface View {
  drive: { realSample: string | null; baseCurrency: string };
  receipts: { id: string; status: string; flags: { code: string }[] }[];
  ledger: { receiptId: string | null; kind: string }[];
  payouts: { receiptId: string }[];
  paypal: { method: string; path?: string; url?: string }[];
}

const viewOf = async (request: APIRequestContext, id: string): Promise<View> => (await (await request.get(`/api/drives/${id}`)).json()) as View;
const captures = (v: View) => v.paypal.filter((c) => /\/capture$/.test(c.path ?? c.url ?? "")).length;

test("the Kitasora drive offers no real receipt button", async ({ page }) => {
  await open(page, "Open the demo drive");
  await expect(page.getByRole("button", { name: "Use the sample receipt" })).toBeVisible();
  await expect(page.getByRole("button", { name: REAL })).toHaveCount(0);
});

test("on the Florida drive the real 2019 receipt is held for a person and moves no money", async ({ page, request }) => {
  const id = await open(page, "Open the Florida drive");
  const before = await viewOf(request, id);
  expect(before.drive).toMatchObject({ realSample: "florida-real", baseCurrency: "USD" });

  // The Coordinator's empty panel offers it next to the sample receipt.
  await expect(page.getByRole("button", { name: REAL })).toBeVisible();
  await expect(page.locator(".co-realNote")).toContainText("A real Florida grocery receipt (2019)");

  // A volunteer sends it from the upload form.
  await page.goto(`/drive/${id}?as=volunteer`);
  await expect(page.locator(".vo-realNote")).toContainText("A real Florida grocery receipt (2019)");
  await page.getByRole("button", { name: REAL }).click();
  await expect(page.getByText("With the coordinator")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("No money moves until they decide")).toBeVisible();

  const after = await viewOf(request, id);
  expect(after.receipts).toHaveLength(1);
  const r = after.receipts[0];
  expect(r.status).toBe("review");
  expect(r.flags.map((f) => f.code)).toContain("pre_disaster");
  expect(after.ledger.filter((l) => l.receiptId === r.id && l.kind !== "rejected")).toEqual([]);
  expect(after.payouts.filter((p) => p.receiptId === r.id)).toEqual([]);
  expect(captures(after)).toBe(captures(before));

  // The Coordinator sees it waiting for a decision, not refused.
  await page.goto(`/drive/${id}?as=coordinator`);
  await expect(page.locator(".co-pMid")).toContainText(/Your decision|This receipt cannot be approved/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: REAL })).toHaveCount(0);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
  [1920, 1080],
  [390, 844],
] as const) {
  test(`at ${width}×${height} the Florida drive's five needs all fit the shelter's card, nothing in its scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const id = await open(page, "Open the Florida drive");
    await page.goto(`/drive/${id}?as=ledger`);
    const list = page.locator(".lg-shelter ul");
    await expect(list.locator("li")).toHaveCount(5, { timeout: 60_000 });
    await expect(list).toHaveClass(/lg-many/);
    // Before the smaller rows the card scrolled: AA batteries cut in half, Blankets out of sight (crawl of 11.11).
    expect(await list.evaluate((ul) => ul.scrollHeight - ul.clientHeight)).toBeLessThanOrEqual(1);
    const box = (await list.boundingBox())!;
    for (const li of await list.locator("li").all()) {
      const b = (await li.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    await expect(page.locator(".lg-shelter").getByText("Blankets")).toBeVisible();
    // The money line under each bar is whole: one line, nothing cut.
    const cut = await page.locator(".lg-shelter .nm-money").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(cut).toEqual([]);
  });
}
