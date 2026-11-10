import { expect, test, type Page } from "@playwright/test";

// Things on the Ledger that must sit inside their own place, measured in a real browser on a real demo drive (the
// sample receipt, recorded sandbox, no network): the refusal's reason and every status pill inside their cell of the
// book, and nothing drawn over the link to the shelter's poster. 1440 and 390, EN, DE and JA.

let driveId = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 90_000 });
  driveId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-rej")).toHaveCount(2, { timeout: 60_000 });
  await page.close();
});

async function openBook(page: Page, lang: string) {
  await page.goto(`/drive/${driveId}?as=ledger&lang=${lang}`);
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /Every line of the book|Jede Zeile des Buchs|帳簿の全行/ }).click();
  await expect(page.locator(".ag-root-wrapper")).toBeVisible();
  await expect(page.locator(".ag-row .lg-pill-status").first()).toBeVisible();
  // The rows ease into place: measure once they stand still.
  await page.waitForTimeout(800);
}

/** Pills and reasons of the book that reach out of their cell (box past an edge, or text wider than the pill). */
const outOfCell = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".ag-row .lg-pill-status, .ag-row .lg-reason")].flatMap((e) => {
      const cell = e.closest(".ag-cell");
      if (!cell) return [];
      const c = cell.getBoundingClientRect();
      const r = e.getBoundingClientRect();
      const out = r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1 || e.scrollWidth > e.clientWidth + 1;
      return out ? [`${e.className}: ${e.textContent} [${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(c.left)}..${Math.round(c.right)} x ${Math.round(c.top)}..${Math.round(c.bottom)}]`] : [];
    }),
  );

/** Text drawn over the poster link: any other visible text whose box crosses the link's. */
const overPoster = (page: Page) =>
  page.evaluate(() => {
    const link = document.querySelector<HTMLElement>("[data-testid=poster-link]");
    if (!link) return ["no poster link"];
    const p = link.getBoundingClientRect();
    const hit = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left < p.right - 1 && p.left < r.right - 1 && r.top < p.bottom - 1 && p.top < r.bottom - 1;
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || link.contains(el) || !(n.textContent ?? "").trim() || getComputedStyle(el).visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (hit(r)) out.push((n.textContent ?? "").trim());
    }
    return [...new Set(out)];
  });

for (const [label, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
  test.describe(`the Ledger at ${label}`, () => {
    test.use({ viewport: { width, height } });
    for (const lang of ["en", "de", "ja"]) {
      test(`${lang}: every status pill and refusal reason inside its cell; nothing over the poster link`, async ({ page }) => {
        await openBook(page, lang);
        if (width > 600) await expect(page.locator(".ag-row .lg-reason")).toHaveCount(2);
        expect(await outOfCell(page)).toEqual([]);
        await expect(page.getByTestId("poster-link")).toBeVisible();
        await page.getByTestId("poster-link").scrollIntoViewIfNeeded();
        expect(await overPoster(page)).toEqual([]);
      });
    }
  });
}
