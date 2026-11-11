import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// "Try it as two people" (README): a second person pledges for the water next to Lena, approves the hold in PayPal's
// window, and the sample receipt splits the water lines across both holds and the match. With two donors on one need the
// lines "From Lena (…) + Second donor (…) + match (…)" (Donor) and "¥1,486 = Lena … + Second donor … + Kitasora
// Logistics …" (Coordinator) are longer than one line of their card: they wrap, the whole text stays inside the card and
// the page never scrolls sideways. Run by florida.config.ts (PayPal answered by the stateful stand-in, whose approval of
// an order the e2e server takes on POST /__e2e/approve/<order id>).

const SECOND = "Second donor";

async function driveWithTwoWaterDonors(request: APIRequestContext): Promise<string> {
  const drive = await request.post("/api/demo/drives");
  expect(drive.status()).toBe(201);
  const id = ((await drive.json()) as { drive: { id: string } }).drive.id;

  const pledge = await request.post(`/api/drives/${id}/pledges`, {
    data: { needId: "water", donorName: SECOND, amount: { currency: "EUR", minor: 500 } },
  });
  expect(pledge.status()).toBe(201);
  const { pledgeId, orderId } = (await pledge.json()) as { pledgeId: string; orderId: string };
  expect((await request.post(`/__e2e/approve/${orderId}`)).status()).toBe(204);
  const approved = await request.post(`/api/pledges/${pledgeId}/approve`, { data: { orderId } });
  expect(((await approved.json()) as { status: string }).status).toBe("authorized");

  const receipt = await request.post(`/api/drives/${id}/receipts`, { multipart: { sample: "hero" } });
  expect(receipt.status()).toBe(201);
  return id;
}

/** Every piece of text in `sel` (the one naming the second donor) that lies outside its own card `card`, and the page's sideways scroll. */
async function outside(page: Page, sel: string, card: string) {
  return page.evaluate(
    ([sel, card, who]) => {
      const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent ?? "").includes(who));
      if (!el) return { found: false, out: [] as string[], scroll: 0, text: "" };
      const box = el.closest(card)!.getBoundingClientRect();
      const out: string[] = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(n.textContent ?? "");
      }
      const de = document.documentElement;
      return { found: true, out, scroll: de.scrollWidth - de.clientWidth, text: el.textContent ?? "" };
    },
    [sel, card, SECOND] as const,
  );
}

let id = "";
test.beforeAll(async ({ request }) => {
  id = await driveWithTwoWaterDonors(request);
});

for (const [width, height] of [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [390, 844],
] as const) {
  test(`${width}: two donors on one need, the Donor's "From" line stays inside its card`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/drive/${id}`);
    await expect(page.getByText(`${SECOND} (€0.92)`, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    const m = await outside(page, ".dn-ltFrom", ".dn-lt");
    expect(m.found).toBe(true);
    expect(m.text).toMatch(/Lena \(€3\.65\) \+ Second donor \(€0\.92\) \+ match \(¥743\)/);
    expect(m.out).toEqual([]);
    expect(m.scroll).toBeLessThanOrEqual(0);
  });

  test(`${width}: two donors on one need, the Coordinator's "Who pays" line stays inside its row`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/drive/${id}?as=coordinator`);
    await expect(page.locator(".co-eq", { hasText: SECOND })).toBeVisible({ timeout: 60_000 });
    const m = await outside(page, ".co-eq", ".co-wrow");
    expect(m.found).toBe(true);
    expect(m.text).toMatch(/Lena ¥594 \(€3\.65\) \+ Second donor ¥149 \(€0\.92\) \+ Kitasora Logistics ¥743/);
    expect(m.out).toEqual([]);
    expect(m.scroll).toBeLessThanOrEqual(0);
    // The taller row stays inside the "Who pays" panel: wrapping must not push it under the panel's edge.
    const rowInPanel = await page.locator(".co-wrow", { hasText: SECOND }).evaluate((row) => {
      const r = row.getBoundingClientRect();
      const p = row.closest(".co-panel")!.getBoundingClientRect();
      return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.right <= p.right + 1;
    });
    expect(rowInPanel).toBe(true);
  });
}
