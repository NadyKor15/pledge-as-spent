import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { DriveView } from "../../src/ui/types";
import { heroClosed } from "../fixtures/closed-hero";

// The book of the Ledger tab as its design (PROOF-B) draws it:
// a strip of the printed receipt line in each row, PayPal's capture, the status pill, a proof band under a pressed
// row; the flash of a row PayPal just moved; EN · DE · JA; and the assistant's points into the book.
// Runs on the real snapshot tests/fixtures/drives/closed.json (and open.json for the live book), no network.

const ROOT = path.resolve(__dirname, "../..");
const SHOTS = process.env.BOOK_SHOTS ?? path.join(ROOT, "tmp/book-shots");
mkdirSync(SHOTS, { recursive: true });

const fixture = (name: "closed" | "open") => JSON.parse(readFileSync(path.join(ROOT, `tests/fixtures/drives/${name}.json`), "utf8")) as DriveView;
/** The published copy of the sample receipt: the photo closed to its purchase lines, as the reading makes it. */
const published = heroClosed();

const MARK4 = "demo-f372326129.r1:4/demo-f372326129.diapers";

async function openBook(page: Page, view: DriveView | ((count?: boolean) => DriveView), query = "") {
  const first = typeof view === "function" ? view(false) : view;
  const id = first.drive.id;
  await page.route(`**/api/drives/${id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(typeof view === "function" ? view() : view) }));
  await page.route("**/api/receipts/*/image", (r) => r.fulfill({ contentType: "image/png", body: published }));
  await page.goto(`/drive/${id}?as=ledger${query}`);
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Every line of the book|Jede Zeile des Buchs|帳簿の全行/ }).click();
  await expect(page.locator(".ag-root-wrapper")).toBeVisible();
  return id;
}

const rows = (page: Page) => page.locator(".ag-row");
/** Opens the book unless it is open: the store keeps it open across a rebuilt report (a language switch). */
async function openTheBook(page: Page, name: RegExp) {
  const button = page.getByRole("button", { name });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(page.locator(".ag-root-wrapper")).toBeVisible();
}
const store = (page: Page, call: string) => page.evaluate(`(() => { const s = document.querySelector(".lg-screen").ledgerStore; return ${call}; })()`);
/** A row's top within the grid's rows, so a scroll of the page does not count. */
const rowTop = (page: Page, key: string) =>
  page.locator(`.ag-row:has([data-row-key="${key}"])`).evaluate((e) => e.getBoundingClientRect().top - e.closest(".ag-root-wrapper")!.getBoundingClientRect().top);
const wider = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("the book at 1440 × 900, as PROOF-B", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("each row: the printed line cut from the published photo, the payer with their town, PayPal's capture, a status pill", async ({ page }) => {
    await openBook(page, fixture("closed"));
    await expect(rows(page)).toHaveCount(20);
    await expect(page.locator(".ag-header-cell-text")).toHaveText(["Line", "Receipt line", "Need", "Payer", "Share", "PayPal capture", "Status"]);
    // Every line of the sample receipt has a box: one strip per row, all cut from the published copy.
    await expect(page.locator(".ag-row .lg-strip")).toHaveCount(20);
    const sources = await page.locator(".ag-row .lg-strip").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundImage))]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^url\("http:\/\/127\.0\.0\.1:\d+\/api\/receipts\/demo-f372326129\.r1\/image"\)$/);
    const mark = page.locator(`.ag-row:has([data-row-key="${MARK4}"])`);
    await expect(mark).toContainText("Soft kids diapers M");
    await expect(mark).toContainText("Mark · Columbus");
    await expect(mark).toContainText("$8.58");
    await expect(mark.locator(".lg-capture")).toHaveText("PayPal capture5PE922386K0983923");
    await expect(mark.locator(".lg-pill-status")).toHaveText("Spent");
    const beer = page.locator('.ag-row:has([data-row-key="demo-f372326129.r1:10/rejected"])');
    await expect(beer.locator(".lg-pill-status")).toHaveText("Refused");
    await expect(beer.locator(".lg-reason")).toHaveText("Alcohol is not funded");
    await expect(beer).toContainText("no capture");
    expect(await wider(page)).toBeLessThanOrEqual(0);
    await settled(page);
    await page.locator(".ag-root-wrapper").screenshot({ path: path.join(SHOTS, "book-1440-rows.png") });
  });

  test("a pressed row opens its proof band under it; the rows below make room; a second press closes it", async ({ page }) => {
    await openBook(page, fixture("closed"));
    const next = "demo-f372326129.r1:4/demo-f372326129.match";
    // The grid slides its rows into place when they load: measure once they stand still.
    let before = NaN;
    await expect.poll(async () => {
      const a = await rowTop(page, next);
      await page.waitForTimeout(250);
      before = await rowTop(page, next);
      return a === before;
    }).toBe(true);
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    const band = page.locator(".lg-band");
    await expect(band).toBeVisible();
    await expect(band.locator(".lg-band-sentence")).toHaveText("Line 4 · Soft kids diapers M · ¥2,596 = Mark · Columbus $8.58 (¥1,298) + Kitasora Logistics match ¥1,298");
    await expect(band.locator(".lg-band-store")).toHaveText("ミナト生活館 北空店 · receipt ¥14,646");
    await expect(band.locator(".lg-band-paypal")).toContainText("5PE922386K0983923 · Completed · Nov 1, 02:06 UTC");
    await expect(band.locator(".lg-band-paypal")).toContainText("Match capture64424341AL727524D");
    await expect(band.locator(".lg-strip")).toHaveCount(1);
    // The page's assistant answers "Ask about this line"; without it there is no button.
    await expect(band.getByRole("button", { name: "Ask about this line" })).toBeVisible();
    await store(page, `(s.setAskAbout(null), true)`);
    await expect(page.getByRole("button", { name: "Ask about this line" })).toHaveCount(0);
    // The next row sits under the band, not under it hidden.
    const bandBox = (await band.boundingBox())!;
    // The rows ease down (0.2 s): wait for them to settle.
    await expect.poll(async () => (await rowTop(page, next)) - before).toBeGreaterThan(bandBox.height - 4);
    await page.waitForTimeout(300);
    const nextBox = (await page.locator(`.ag-row:has([data-row-key="${next}"])`).boundingBox())!;
    expect(nextBox.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 2);
    // The band is as wide as the book.
    const grid = (await page.locator(".ag-root-wrapper").boundingBox())!;
    expect(Math.abs(bandBox.width - grid.width)).toBeLessThan(4);
    // The last row stays on the page under the band.
    const last = (await page.locator('.ag-row:has([data-row-key="demo-f372326129.r1:11/rejected"])').boundingBox())!;
    const frame = (await page.locator(".lg-frame").boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(frame.y + frame.height + 1);

    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-book-head")!.getBoundingClientRect().top - 8));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-1440-proof-no-assistant.png") });
    // As PROOF-B draws it, with the assistant plugged in: its "Ask about this line".
    await store(page, `(s.setAskAbout(() => {}), true)`);
    await expect(band.getByRole("button", { name: "Ask about this line" })).toBeVisible();
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-1440-proof.png") });
    await store(page, `(s.setAskAbout(null), true)`);

    // Pressing inside the band does not close it; the same row again does.
    await band.locator(".lg-band-sentence").click();
    await expect(band).toBeVisible();
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await expect(page.locator(".lg-band")).toHaveCount(0);
    await expect.poll(() => rowTop(page, next)).toBe(before);
  });

  test("Enter on a row opens its proof from the keyboard", async ({ page }) => {
    await openBook(page, fixture("closed"));
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .ag-cell`).first().click();
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await expect(page.locator(".lg-band")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator(".lg-band")).toBeVisible();
  });

  test("no box for a line: no strip in its rows and none in its band, never another line's", async ({ page }) => {
    const v = fixture("closed");
    v.receipts[0].lines[3].box = null;
    await openBook(page, v);
    await expect(page.locator(".ag-row .lg-strip")).toHaveCount(18);
    await expect(page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-strip`)).toHaveCount(0);
    await expect(page.locator(`.ag-row:has([data-row-key="${MARK4}"])`)).toContainText("Soft kids diapers M");
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await expect(page.locator(".lg-band .lg-strip")).toHaveCount(0);
    await expect(page.locator(".lg-band-printed")).toHaveText("ソフトキッズおおむつ M 44 枚");
  });

  test("an unpublished photo: no strips at all", async ({ page }) => {
    const v = fixture("closed");
    v.receipts[0].image = { published: false, note: "Personal data was found but could not be blurred, so this image is not published." } as never;
    await openBook(page, v);
    await expect(rows(page)).toHaveCount(20);
    await expect(page.locator(".lg-strip")).toHaveCount(0);
  });

  test("Ask about this line: the assistant's callback gets the line; the slot over the book shows its chat", async ({ page }) => {
    await openBook(page, fixture("closed"));
    const height = async () => (await page.locator(".lg-frame").boundingBox())!.height;
    // The page's own chat is in the slot from the start; without a component there is no slot and no height for it.
    await expect(page.locator(".lg-ask-slot [data-testid=ask-widget]")).toBeVisible();
    await store(page, `(s.setAskComponent(null), true)`);
    await expect(page.locator(".lg-ask-slot")).toHaveCount(0);
    const without = await height();
    await store(page, `(window.asked = [], s.setAskAbout((k) => window.asked.push(k)), true)`);
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await page.getByRole("button", { name: "Ask about this line" }).click();
    expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toEqual(["demo-f372326129.r1:4"]);
    // A component for the slot: the report makes room for it right over the book.
    await store(page, `(s.setAskComponent(() => "The assistant's chat goes here"), true)`);
    await expect(page.locator(".lg-ask-slot")).toHaveText("The assistant's chat goes here");
    const slot = (await page.locator(".lg-ask-slot").boundingBox())!;
    const head = (await page.locator(".lg-book-head").boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(slot.y + slot.height - 2);
    expect(slot.width).toBeGreaterThan(1400);
    expect(await height()).toBeGreaterThan(without + 400);
    await store(page, `(s.setAskComponent(null), true)`);
    await expect(page.locator(".lg-ask-slot")).toHaveCount(0);
  });

  test("focusLines narrows the book to the assistant's lines, tints them, and a chip over the book undoes it", async ({ page }) => {
    const v = fixture("closed");
    const id = v.drive.id;
    await page.route(`**/api/drives/${id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(v) }));
    await page.route("**/api/receipts/*/image", (r) => r.fulfill({ contentType: "image/png", body: published }));
    await page.goto(`/drive/${id}?as=ledger`);
    await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
    // The book is closed: the assistant's narrowing opens it.
    const keys = ["demo-f372326129.r1:4", "demo-f372326129.r1:5", "demo-f372326129.r1:6"];
    await store(page, `(s.focusLines(${JSON.stringify(keys)}, "Mark · Columbus"), true)`);
    await expect(page.locator(".ag-root-wrapper")).toBeVisible();
    await expect(rows(page)).toHaveCount(6);
    await expect(page.locator(".lg-chip")).toHaveText(/^Narrowed by the assistant: Mark · Columbus/);
    await expect(page.locator(".ag-row.lg-focused")).toHaveCount(6);
    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-book-head")!.getBoundingClientRect().top - 8));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-1440-narrowed.png") });
    await page.getByRole("button", { name: "Show every line" }).click();
    await expect(rows(page)).toHaveCount(20);
    await expect(page.locator(".lg-chip")).toHaveCount(0);
    await expect(page.locator(".ag-row.lg-focused")).toHaveCount(0);
  });
});

test.describe("the live book: a row flashes when PayPal moves its money", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /**
   * The open drive just after "Capture now": every share submitted, PayPal not yet answered (so the page keeps
   * reading it); four seconds after the first read, PayPal has captured them all.
   */
  function captureLater() {
    const pending = fixture("open");
    pending.holds = pending.holds.map((h) => ({ ...h, capturePending: h.authorized > 0 ? 1 : 0 }));
    pending.ledger = pending.ledger.map((r) => (r.kind === "donor_share" || r.kind === "match_share" ? { ...r, status: "capture_pending" as const } : r));
    const done = fixture("open");
    done.ledger = done.ledger.map((r) => (r.kind === "donor_share" || r.kind === "match_share" ? { ...r, status: "captured" as const, captureId: `CAP${r.lineNo}${r.kind === "match_share" ? "M" : "D"}` } : r));
    let first = 0;
    return (count = true) => {
      if (!count) return pending;
      first ||= Date.now();
      return Date.now() - first < 4000 ? pending : done;
    };
  }

  test("green on the rows PayPal took, through the rebuild of the report, then gone", async ({ page }) => {
    await openBook(page, captureLater());
    await expect(page.locator(".ag-row.lg-flash-spent").first()).toBeVisible({ timeout: 15_000 });
    // "Donors' money approved" became "Donors' money spent": Studio was rebuilt, and the flash is still on the new rows.
    await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Donors’ money spent" })).toHaveCount(1);
    await expect(page.locator(".ag-row.lg-flash-spent")).toHaveCount(18);
    await expect(page.locator(".ag-row.lg-flash-back")).toHaveCount(0);
    await page.locator(".ag-root-wrapper").screenshot({ path: path.join(SHOTS, "book-1440-flash.png") });
    await expect(page.locator(".ag-row.lg-flash-spent")).toHaveCount(0, { timeout: 6_000 });
  });

  test("with reduced motion the rows are tinted, nothing moves", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBook(page, captureLater());
    await expect(page.locator(".ag-row.lg-flash-spent").first()).toBeVisible({ timeout: 15_000 });
    const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a as CSSAnimation).animationName?.startsWith("lg-flash")).length);
    expect(moving).toBe(0);
    const tint = await page.locator(".ag-row.lg-flash-spent").first().evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(tint).not.toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("EN · DE · JA", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one switch rebuilds the book in the language; ?lang= keeps it across a reload", async ({ page }) => {
    await openBook(page, fixture("closed"));
    await page.getByRole("button", { name: "DE", exact: true }).click();
    await expect(page).toHaveURL(/[?&]lang=de/);
    await expect(page.locator(".ag-studio-value-widget-content").first()).toHaveText("10.783 ¥", { timeout: 15_000 });
    await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Nie belastet" })).toHaveCount(1);
    await openTheBook(page, /Jede Zeile des Buchs/);
    await expect(page.locator(".ag-header-cell-text")).toHaveText(["Zeile", "Belegzeile", "Bedarf", "Zahler", "Anteil", "PayPal-Abbuchung", "Status"]);
    await expect(page.locator(`.ag-row:has([data-row-key="${MARK4}"])`)).toContainText("8,58 $");
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await expect(page.locator(".lg-band-sentence")).toHaveText("Zeile 4 · Soft kids diapers M · 2.596 ¥ = Mark · Columbus 8,58 $ (1.298 ¥) + Kitasora Logistics Zuschuss 1.298 ¥");
    await store(page, `(s.setAskAbout(() => {}), true)`);
    await expect(page.getByRole("button", { name: "Zu dieser Zeile fragen" })).toBeVisible();
    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-book-head")!.getBoundingClientRect().top - 8));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-1440-de.png") });
    await page.reload();
    await expect(page.locator(".ag-studio-value-widget-content").first()).toHaveText("10.783 ¥", { timeout: 60_000 });

    await page.getByRole("button", { name: "JA", exact: true }).click();
    await expect(page).toHaveURL(/[?&]lang=ja/);
    await expect(page.locator(".lg-screen")).toHaveAttribute("lang", "ja");
    await expect(page.locator(".ag-studio-value-widget-content").first()).toHaveText("¥10,783", { timeout: 15_000 });
    await openTheBook(page, /帳簿の全行/);
    await expect(page.locator(".ag-header-cell-text")).toHaveText(["行", "レシートの行", "必要品", "支払者", "負担額", "PayPal 引き落とし", "状態"]);
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-item-name`).click();
    await expect(page.locator(".lg-band-paypal")).toContainText("完了 · 11月1日 02:06 UTC");
    // The Japanese font is a Japanese one, not a fallback box: the glyphs have width.
    const glyph = await page.locator(".ag-header-cell-text").nth(1).evaluate((e) => ({ family: getComputedStyle(e).fontFamily, width: e.getBoundingClientRect().width }));
    expect(glyph.family).toMatch(/Hiragino|Noto Sans JP|Yu Gothic|sans-serif/);
    expect(glyph.width).toBeGreaterThan(60);
    await store(page, `(s.setAskAbout(() => {}), true)`);
    await expect(page.getByRole("button", { name: "この行について質問" })).toBeVisible();
    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-book-head")!.getBoundingClientRect().top - 8));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-1440-ja.png") });
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page).not.toHaveURL(/lang=/);
  });
});

test.describe("the book on a phone, 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("four columns, the proof band under a pressed row, nothing wider than the screen", async ({ page }) => {
    await openBook(page, fixture("closed"));
    await expect(page.locator(".ag-header-cell-text")).toHaveText(["What", "Who", "How much", "Status"]);
    await expect(rows(page)).toHaveCount(20);
    // How much is each payer's share in the payer's own currency, as on the desktop and in the agent's answer.
    await expect(page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .ag-cell[col-id="book.much"]`)).toHaveText("$8.58");
    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-book-head")!.getBoundingClientRect().top - 8));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-390-rows.png") });
    await page.locator(`.ag-row:has([data-row-key="${MARK4}"]) .lg-what-name`).click();
    const band = page.locator(".lg-band");
    await expect(band).toBeVisible();
    await expect(band.locator(".lg-strip")).toHaveCount(1);
    await expect(band.locator(".lg-band-sentence")).toContainText("Line 4 · Soft kids diapers M · ¥2,596");
    const box = (await band.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(await wider(page)).toBeLessThanOrEqual(0);
    // The rows under the band ease down (0.2 s) and end below it, none hidden under it.
    const next = page.locator('.ag-row:has([data-row-key="demo-f372326129.r1:4/demo-f372326129.match"])');
    await expect.poll(async () => (await next.boundingBox())!.y - (box.y + box.height)).toBeGreaterThanOrEqual(-2);
    await expect(page.locator(".ag-row.lg-proof-row")).toHaveCount(1);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollBy(0, document.querySelector(".lg-band")!.getBoundingClientRect().top - 160));
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, "book-390-proof.png") });
  });
});

// Round 2 (main session's finding on book-1440-ja.png): under an open band, two rows were hidden. Every row after
// the band must be on the page and uncovered, whatever the band holds: each language, with "Ask" and without,
// on a desktop and on a phone. Checked once nothing moves any more, with the very element the browser finds at
// the middle of each row.
const LABEL: Record<"en" | "de" | "ja", RegExp> = { en: /Every line of the book/, de: /Jede Zeile des Buchs/, ja: /帳簿の全行/ };

/** Resolves when no CSS transition or animation is running on the book's rows or the band. */
const settled = (page: Page) =>
  page.waitForFunction(
    () =>
      document.getAnimations().filter((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target;
        return a.playState === "running" && target instanceof Element && target.closest(".ag-root-wrapper");
      }).length === 0,
  );

/** Rows after `key` that the browser does not find at their own middle (hidden, covered or off the book). */
async function coveredAfter(page: Page, key: string) {
  const keys = await page.locator(".ag-row [data-row-key]").evaluateAll((els, k) => {
    const rows = els.map((e) => ({ key: e.getAttribute("data-row-key")!, top: e.closest(".ag-row")!.getBoundingClientRect().top }));
    const at = rows.find((r) => r.key === k)!.top;
    return rows.filter((r) => r.top > at).sort((a, b) => a.top - b.top).map((r) => r.key);
  }, key);
  const out: string[] = [];
  for (const k of keys) {
    const row = page.locator(`.ag-row:has([data-row-key="${k}"])`);
    await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const ok = await row.evaluate((e) => {
      const b = e.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit?.closest(".ag-row") === e;
    });
    if (!ok) out.push(k);
  }
  return { keys, out };
}

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const lang of ["en", "de", "ja"] as const) {
    for (const ask of [false, true]) {
      test(`under an open band every later row stays in sight: ${width} px, ${lang}, ${ask ? "with" : "without"} Ask`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        const v = fixture("closed");
        const id = v.drive.id;
        await page.route(`**/api/drives/${id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(v) }));
        await page.route("**/api/receipts/*/image", (r) => r.fulfill({ contentType: "image/png", body: published }));
        await page.goto(`/drive/${id}?as=ledger${lang === "en" ? "" : `&lang=${lang}`}`);
        await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
        // The page's assistant gives "Ask about this line" a callback; "without" takes it away.
        await store(page, ask ? `(s.setAskAbout(() => {}), true)` : `(s.setAskAbout(null), true)`);
        await page.getByRole("button", { name: LABEL[lang] }).click();
        await expect(rows(page)).toHaveCount(20);
        await page.locator(`[data-row-key="${MARK4}"]`).click();
        const band = page.locator(".lg-band");
        await expect(band).toBeVisible();
        await expect(band.locator(".lg-ask-line")).toHaveCount(ask ? 1 : 0);
        await settled(page);
        // Nothing in the band spills out of it.
        expect(await band.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
        const { keys, out } = await coveredAfter(page, MARK4);
        expect(keys).toHaveLength(13);
        expect(out).toEqual([]);
      });
    }
  }
}
