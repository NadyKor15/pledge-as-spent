import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { moneyIn, type Lang } from "../../src/ui/format";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { riverModel } from "../../src/ui/river/model";
import { RIVER_WORDS } from "../../src/ui/river/words";
import type { DriveView } from "../../src/ui/types";

// The river of money (variant A), in a real browser on the real snapshots tests/fixtures/drives/closed.json and open.json (no
// network): the seven steps, the sums equal to the Ledger's (deriveLedger), PayPal's ids whole, nothing out of its
// card or off the screen at 1440 and 390 in EN, DE and JA; the 20-second playback and Replay; reduced motion; the
// Ledger's link to it next to the poster's. The build has the river switched on (river.config.ts).

const ROOT = path.resolve(__dirname, "../..");
const fixture = (name: "closed" | "open") => JSON.parse(readFileSync(path.join(ROOT, `tests/fixtures/drives/${name}.json`), "utf8")) as DriveView;
const LANGS: Lang[] = ["en", "de", "ja"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function openRiver(page: Page, view: DriveView, lang: Lang = "en", reduce = true) {
  if (reduce) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(`**/api/drives/${view.drive.id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(view) }));
  await page.goto(`/drive/${view.drive.id}/river${lang === "en" ? "" : `?lang=${lang}`}`);
  await expect(page.getByTestId("river")).toBeVisible({ timeout: 60_000 });
  if (reduce) await expect(page.getByTestId("river")).toHaveAttribute("data-step", "7", { timeout: 3_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(300);
}

/** Everything of the river that leaves its place: the page wider than the screen, a card off it, text out of its card or
 *  head, two cards over each other, a PayPal id cut, the header's parts over each other. */
const misfits = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page ${document.documentElement.scrollWidth} wider than ${vw}`);
    const inside = (el: Element, r: DOMRect, what: string) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = (n.textContent ?? "").trim();
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const t of range.getClientRects())
          if (t.width > 0 && (t.left < r.left - 0.5 || t.right > r.right + 0.5 || t.top < r.top - 0.5 || t.bottom > r.bottom + 0.5)) out.push(`${what}: "${text}" out of its box`);
      }
    };
    const cards = [...document.querySelectorAll<HTMLElement>("[data-card]")];
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5) out.push(`${c.dataset.card} off the screen [${Math.round(r.left)}..${Math.round(r.right)}]`);
      if (c.scrollWidth > c.clientWidth + 1) out.push(`${c.dataset.card} wider inside than its box: ${c.textContent}`);
      inside(c, r, c.dataset.card ?? "card");
    }
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i].getBoundingClientRect();
        const b = cards[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) out.push(`${cards[i].dataset.card} over ${cards[j].dataset.card}: ${cards[i].textContent} / ${cards[j].textContent}`);
      }
    for (const h of document.querySelectorAll<HTMLElement>("[data-head]")) {
      const box = (h.parentElement ?? h).getBoundingClientRect();
      if (box.left < -0.5 || box.right > vw + 0.5) out.push(`head ${h.dataset.head} off the screen`);
      inside(h, box, `head ${h.dataset.head}`);
    }
    for (const id of document.querySelectorAll<HTMLElement>("[data-paypal-id]")) if (id.scrollWidth > id.clientWidth + 0.5) out.push(`PayPal id cut: ${id.textContent}`);
    const top = [...document.querySelectorAll<HTMLElement>("header > *")];
    for (let i = 0; i < top.length; i++) {
      const a = top[i].getBoundingClientRect();
      if (a.right > vw + 0.5) out.push(`header part off the screen: ${top[i].textContent}`);
      for (let j = i + 1; j < top.length; j++) {
        const b = top[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`header parts over each other: ${top[i].textContent} / ${top[j].textContent}`);
      }
    }
    return [...new Set(out)];
  });

/** The columns' titles and notes. */
const HEADS = "[data-head] .rv-headTitle > span:last-child, [data-head] .rv-note";

/**
 * Words of `selector` broken across two lines ("Kassenbo / n"). A word is what lies between spaces and the Japanese
 * zero-width spaces; a line may also end after a hyphen. Runs in the page (page.evaluate).
 */
function brokenWords(selector: string): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll(selector)) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.textContent ?? "";
      for (const m of text.matchAll(/[^\s​-]+-?/g)) {
        const range = document.createRange();
        range.setStart(n, m.index ?? 0);
        range.setEnd(n, (m.index ?? 0) + m[0].length);
        const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (lines.size > 1) out.push(m[0]);
      }
    }
  }
  return out;
}

/**
 * Ribbons that run through a card other than the two they join: points along each ribbon's outline, in the page. A
 * rest is a line (data-stroke = its width): its middle must stay half that width away from every other card.
 */
const throughCards = (page: Page) =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>("[data-card]")].map((e) => ({ node: e.dataset.node ?? "", name: `${e.dataset.card}: ${e.textContent?.slice(0, 30)}`, r: e.getBoundingClientRect() }));
    const out: string[] = [];
    for (const g of document.querySelectorAll<SVGGElement>("g[data-ribbon]")) {
      const own = (g.dataset.ends ?? "").split(" ");
      for (const p of g.querySelectorAll<SVGPathElement>("path")) {
        const len = p.getTotalLength();
        const m = p.getScreenCTM()!;
        const e = 1.5 - Number(p.getAttribute("data-stroke") ?? 0) / 2;
        for (let i = 0; i <= 400; i++) {
          const pt = p.getPointAtLength((len * i) / 400);
          const x = m.a * pt.x + m.c * pt.y + m.e;
          const y = m.b * pt.x + m.d * pt.y + m.f;
          for (const c of cards)
            if (!own.includes(c.node) && x > c.r.left + e && x < c.r.right - e && y > c.r.top + e && y < c.r.bottom - e) out.push(`${g.dataset.ribbon} through ${c.name}`);
        }
      }
    }
    return [...new Set(out)];
  });

/** The picture's bottom row: the rests' cards in one row under columns 5–7, in the holds' order, below the payout and
 *  above the sums; and no two rests' lines on top of each other. */
const bottomRow = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const cards = [...document.querySelectorAll<HTMLElement>("[data-card=never]")].map((e) => ({ node: e.dataset.node ?? "", r: e.getBoundingClientRect() }));
    const holds = [...document.querySelectorAll<HTMLElement>("[data-card=hold]")].map((e) => e.dataset.node ?? "");
    const order = cards.map((c) => holds.indexOf(c.node.replace(/^never:/, "hold:")));
    if (order.some((i, k) => i < 0 || (k > 0 && i <= order[k - 1]))) out.push(`not in the holds' order: ${order}`);
    if (cards.some((c, k) => k > 0 && (Math.abs(c.r.top - cards[0].r.top) > 1 || c.r.left < cards[k - 1].r.right))) out.push("not one row, left to right");
    const col5 = document.querySelector<HTMLElement>('[data-head="5"]')!.parentElement!.getBoundingClientRect();
    if (cards.some((c) => c.r.left < col5.left)) out.push("a rest left of column 5");
    const payout = document.querySelector<HTMLElement>("[data-card=payout]")!.getBoundingClientRect();
    const sums = document.querySelector<HTMLElement>("[data-testid=river-sums]")!.getBoundingClientRect();
    if (cards.some((c) => c.r.top < payout.bottom || c.r.bottom > sums.top)) out.push("a rest over the payout or the sums");
    const lines = [...document.querySelectorAll<SVGPathElement>('g[data-kind="never"] path[data-stroke]')].map((p) => {
      const len = p.getTotalLength();
      const m = p.getScreenCTM()!;
      const w = Number(p.getAttribute("data-stroke"));
      const pts = Array.from({ length: 301 }, (_, i) => {
        const pt = p.getPointAtLength((len * i) / 300);
        return [m.a * pt.x + m.c * pt.y + m.e, m.b * pt.x + m.d * pt.y + m.f];
      });
      return { w, pts };
    });
    // A rest that only came back as a refund has its card but no line.
    if (lines.length > cards.length) out.push(`${lines.length} lines for ${cards.length} rests`);
    for (let a = 0; a < lines.length; a++)
      for (let b = a + 1; b < lines.length; b++) {
        let min = Infinity;
        for (const p of lines[a].pts) for (const q of lines[b].pts) min = Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1]));
        if (min < (lines[a].w + lines[b].w) / 2) out.push(`rests ${a} and ${b} overlap (${min.toFixed(1)} px apart)`);
      }
    return out;
  });

/** A phone's links between steps that lie under a card or under text. */
const gapsUnder = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const boxes = [...document.querySelectorAll<HTMLElement>("[data-card], [data-head]")].map((e) => ({ name: e.textContent?.slice(0, 30) ?? "", r: e.getBoundingClientRect() }));
    for (const g of document.querySelectorAll<HTMLElement>("[data-gap] > i")) {
      const a = g.getBoundingClientRect();
      if (a.left < 0 || a.right > document.documentElement.clientWidth) out.push("link off the screen");
      for (const b of boxes) if (Math.min(a.right, b.r.right) - Math.max(a.left, b.r.left) > 0.5 && Math.min(a.bottom, b.r.bottom) - Math.max(a.top, b.r.top) > 0.5) out.push(`link under ${b.name}`);
    }
    return out;
  });

test("the broken-word check catches a word cut in two (and passes the same word with room)", async ({ page }) => {
  await openRiver(page, fixture("closed"), "de");
  const put = (width: number) =>
    page.evaluate((px) => {
      document.querySelector(".rv-selftest")?.remove();
      const p = document.createElement("p");
      p.className = "rv-selftest";
      p.style.cssText = `width:${px}px;overflow-wrap:anywhere;word-break:normal;font:700 16px sans-serif`;
      p.textContent = "Kassenbon";
      document.body.append(p);
    }, width);
  await put(48);
  expect(await page.evaluate(brokenWords, ".rv-selftest")).toEqual(["Kassenbon"]);
  await put(400);
  expect(await page.evaluate(brokenWords, ".rv-selftest")).toEqual([]);
  await expect(page.locator('[data-head="1"]')).toContainText("Beleg");

  // The same for the ribbons' check: a line drawn across the payout card is reported, and none is before it.
  expect(await throughCards(page)).toEqual([]);
  await page.evaluate(() => {
    const r = document.querySelector<HTMLElement>("[data-card=payout]")!.getBoundingClientRect();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("style", `position:fixed;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;pointer-events:none`);
    svg.innerHTML = `<g data-ribbon="probe" data-ends=""><path data-stroke="4" d="M${r.left - 40} ${r.top + r.height / 2}H${r.right + 40}" stroke="red" stroke-width="4"/></g>`;
    svg.classList.add("rv-probe");
    document.body.append(svg);
  });
  expect(await throughCards(page)).toEqual(["probe through payout: " + (await page.locator("[data-card=payout]").textContent())!.slice(0, 30)]);
  await page.evaluate(() => document.querySelector(".rv-probe")?.remove());
});

for (const [label, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
  test.describe(`the river at ${label}`, () => {
    test.use({ viewport: { width, height } });
    for (const lang of LANGS) {
      test(`${lang}: seven steps, the Ledger's sums, PayPal's ids whole, nothing out of place`, async ({ page }) => {
        const v = fixture("closed");
        const l = deriveLedger(v, lang);
        const m = riverModel(v, lang);
        const w = RIVER_WORDS[lang];
        const yen = (minor: number) => moneyIn(lang, v.drive.baseCurrency, minor);
        await openRiver(page, v, lang);
        await expect(page.getByTestId("river")).toHaveAttribute("data-layout", width > 1000 ? "desktop" : "phone");

        // The seven steps, numbered, with the words of this language; column 2 says "Read": this receipt was read once.
        await expect(page.locator("[data-head]")).toHaveCount(7);
        await expect(page.locator("[data-head] .rv-num")).toHaveText(["1", "2", "3", "4", "5", "6", "7"]);
        await expect(page.locator('[data-head="2"]')).toContainText(w.oneReading.title);
        await expect(page.locator('[data-head="7"]')).toContainText(w.never.title);
        await expect(page.getByText(w.readingA)).toHaveCount(0);

        // The sums equal the Ledger's own: donors spent, the match, the payout, never charged. Soft: a wrong sum is
        // reported together with whatever else is out of place below.
        await expect.soft(page.locator("[data-sum=spent]")).toContainText(l.spentLabel, { timeout: 3_000 });
        await expect.soft(page.locator("[data-sum=spent] b")).toHaveText(yen(l.spent), { timeout: 3_000 });
        await expect.soft(page.locator("[data-sum=match] b")).toHaveText(yen(l.match), { timeout: 3_000 });
        await expect.soft(page.locator("[data-sum=paid] b")).toHaveText(yen(l.spent + l.match), { timeout: 3_000 });
        await expect.soft(page.locator("[data-sum=never] b")).toHaveText(yen(l.returned), { timeout: 3_000 });
        await expect.soft(page.locator("[data-money=payout]")).toHaveText(yen(l.spent + l.match), { timeout: 3_000 });
        await expect.soft(page.locator('[data-money=capture][data-kind="match"]')).toHaveText(yen(l.match), { timeout: 3_000 });
        await expect.soft(page.locator("[data-money=receipt]")).toHaveText(yen(14646), { timeout: 3_000 });

        // Each need, its shares (the match's in yen), the refused lines, each donor's rest in the donor's currency.
        await expect(page.locator("[data-card=need]")).toHaveCount(3);
        await expect(page.locator('[data-card=share][data-kind="match"] [data-money]')).toHaveText(m.needs.map((n) => n.shares.find((s) => s.kind === "match")!.text));
        await expect(page.locator("[data-card=refused]")).toHaveCount(2);
        await expect(page.locator("[data-card=refused]").first()).toContainText(w.line(10));
        await expect(page.locator("[data-card=never] b")).toHaveText(m.never.map((n) => w.neverCharged(n.text)));

        // PayPal's ids, every one whole: the holds, this receipt's captures, the payout batch.
        const ids = [...m.holds.flatMap((h) => [h.authorizationId ?? "", ...h.captureIds]), m.payout?.batchId ?? ""].filter(Boolean).sort();
        expect(ids).toHaveLength(9);
        expect((await page.locator("[data-paypal-id]").allTextContents()).sort()).toEqual(ids);

        // A desktop: one ribbon per amount, the rests' three among them, none through another card. A phone: no ribbon at
        // all, only the six short links in the gaps between the seven sections, under nothing.
        if (width > 1000) {
          await expect(page.locator("g[data-ribbon]")).toHaveCount(27);
          await expect(page.locator('g[data-kind="never"]')).toHaveCount(3);
          expect(await throughCards(page)).toEqual([]);
          expect(await bottomRow(page)).toEqual([]);
        } else {
          await expect(page.locator("g[data-ribbon]")).toHaveCount(0);
          await expect(page.locator("[data-gap]")).toHaveCount(6);
          expect(await gapsUnder(page)).toEqual([]);
        }

        expect(await misfits(page)).toEqual([]);
        expect(await page.evaluate(brokenWords, HEADS)).toEqual([]);
      });
    }
  });
}

test("a receipt Meta read twice: column 2 says the two readings agree", async ({ page }) => {
  const v = fixture("closed");
  v.receipts = v.receipts.map((r) => ({ ...r, reader: "cached:meta" }));
  await openRiver(page, v);
  const w = RIVER_WORDS.en;
  await expect(page.locator('[data-head="2"]')).toContainText(w.twoReadings.title);
  await expect(page.getByText(w.readingA, { exact: true })).toBeVisible();
  await expect(page.getByText(w.readingB, { exact: true })).toBeVisible();
  await expect(page.locator("[data-card=read]")).toHaveText(w.agree);
  expect(await throughCards(page)).toEqual([]);
  expect(await misfits(page)).toEqual([]);
  expect(await page.evaluate(brokenWords, HEADS)).toEqual([]);
});

test("the open drive: holds still open, nothing never charged yet; the sums still the Ledger's", async ({ page }) => {
  const v = fixture("open");
  const l = deriveLedger(v, "en");
  await openRiver(page, v);
  await expect(page.locator("[data-card=never]")).toHaveCount(0);
  await expect(page.locator("[data-card=never-open]")).toContainText(RIVER_WORDS.en.stillHeld);
  // Its shares wait for capture: the Ledger's own word, "approved", not "spent".
  await expect(page.locator("[data-sum=spent]")).toContainText(l.spentLabel);
  expect(l.spentLabel).toBe("Donors’ money approved");
  await expect(page.locator("[data-sum=spent] b")).toHaveText(moneyIn("en", "JPY", l.spent));
  await expect(page.locator("[data-sum=paid] b")).toHaveText(moneyIn("en", "JPY", l.spent + l.match));
  await expect(page.locator("[data-sum=never]")).toHaveCount(0);
  await expect(page.locator("p", { hasText: RIVER_WORDS.en.openTail })).toBeVisible();
  // No capture id for this receipt yet: the card waits, it never says "Capture" as if PayPal had taken the money.
  const captures = await page.locator("[data-card=capture]").allTextContents();
  expect(captures).toHaveLength(4);
  for (const text of captures) {
    expect(text).not.toMatch(/Capture/);
    expect(text).toContain(RIVER_WORDS.en.captureWaiting);
    expect(text).toContain(RIVER_WORDS.en.notTakenYet);
  }
  await expect(page.locator("[data-card=capture] [data-paypal-id]")).toHaveCount(0);
  expect(await throughCards(page)).toEqual([]);
  expect(await misfits(page)).toEqual([]);
});

test("plays the seven steps over 20 seconds, one after another; Replay starts again", async ({ page }) => {
  test.setTimeout(90_000);
  await openRiver(page, fixture("closed"), "en", false);
  const root = page.getByTestId("river");
  const clock = page.getByTestId("river-clock");
  const opacity = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).opacity);
  await expect(clock).toHaveText(/^0:0[0-3] \/ 0:20$/);
  expect(Number(await root.getAttribute("data-step"))).toBeLessThan(3);
  expect(await opacity("[data-card=never]")).toBe("0");
  await expect(root).toHaveAttribute("data-step", "4", { timeout: 15_000 });
  expect(await opacity("[data-card=never]")).toBe("0");
  await expect(clock).toHaveText("0:20 / 0:20", { timeout: 30_000 });
  await expect(root).toHaveAttribute("data-step", "7");
  await expect.poll(() => opacity("[data-card=never]")).toBe("1");
  const full = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>("[data-testid=river-bar]")!;
    return Math.abs(bar.getBoundingClientRect().width - bar.parentElement!.getBoundingClientRect().width) < 1;
  });
  expect(full).toBe(true);
  await page.getByTestId("river-replay").click();
  await expect(clock).toHaveText(/^0:0[0-2] \/ 0:20$/);
  expect(Number(await root.getAttribute("data-step"))).toBeLessThanOrEqual(2);
  await expect.poll(() => opacity("[data-card=never]")).toBe("0");
  // ... and plays to the end again.
  await expect(clock).toHaveText("0:20 / 0:20", { timeout: 30_000 });
  await expect(root).toHaveAttribute("data-step", "7");
});

test("← Ledger opens this drive's book, in the river's language", async ({ page }) => {
  const v = fixture("closed");
  await openRiver(page, v, "de");
  const back = page.getByTestId("river-back");
  await expect(back).toHaveText("← Buch");
  await expect(back).toHaveAttribute("href", `/drive/${v.drive.id}?as=ledger&lang=de`);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/drive/${v.drive.id}\\?as=ledger&lang=de$`));
});

// The windows of the acceptance list, and the browser at 125 % and 150 % (1440 → 1152 and 960; 1920 → 1536 and 1280):
// the desktop's columns from 1180 up, scaled to the window with no empty margins and no text under 10 px; below
// (1152, 1024, 960), the river top to bottom. German where the words are longest.
for (const [width, height, lang] of [
  [1024, 768, "en"],
  [1024, 768, "de"],
  [1152, 720, "en"],
  [1180, 800, "en"],
  [1180, 800, "de"],
  [1280, 720, "en"],
  [1280, 800, "en"],
  [1366, 768, "en"],
  [1440, 900, "en"],
  [1536, 864, "en"],
  [1920, 1080, "en"],
  [960, 600, "en"],
  [960, 600, "de"],
] as const) {
  test.describe(`the river at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } });
    test(`${lang}: no sideways scroll, nothing out of its card or the screen, no ribbon through a card, no word cut`, async ({ page }) => {
      await openRiver(page, fixture("closed"), lang);
      const desktop = width >= 1180;
      await expect(page.getByTestId("river")).toHaveAttribute("data-layout", desktop ? "desktop" : "phone");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (desktop) {
        // The columns take the whole width given to them: no empty margins at 1920, nothing cut at 1180.
        const box = (await page.locator(".rv-desk").boundingBox())!;
        expect(box.width).toBeGreaterThan(width - 60);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await throughCards(page)).toEqual([]);
        expect(await bottomRow(page)).toEqual([]);
        // Scaled down, PayPal's ids and every other text of the river stay at 10 px or more on screen.
        const small = await page.evaluate(() => {
          const z = Number(document.querySelector<HTMLElement>("[data-scale]")!.dataset.scale);
          const sizes = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((e) => Number.parseFloat(getComputedStyle(e).fontSize) * z);
          return { z, ids: Math.min(...sizes(".rv-desk .rv-id")), any: Math.min(...sizes(".rv-desk [data-card] *, .rv-desk [data-head] *")) };
        });
        expect(small.ids).toBeGreaterThanOrEqual(9.99);
        expect(small.any).toBeGreaterThanOrEqual(9.99);
      } else {
        expect(await gapsUnder(page)).toEqual([]);
      }
      expect(await misfits(page)).toEqual([]);
      expect(await page.evaluate(brokenWords, HEADS)).toEqual([]);
    });
  });
}

test("reduced motion: every step at once and the bar full", async ({ page }) => {
  await openRiver(page, fixture("closed"), "en", true);
  await expect(page.getByTestId("river-clock")).toHaveText("0:20 / 0:20");
  const opacities = await page.locator(".rv-root [data-step]").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).opacity))]);
  expect(opacities).toEqual(["1"]);
  const transforms = await page.locator("g[data-ribbon]").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).transform))]);
  expect(transforms.every((t) => t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)")).toBe(true);
  const full = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>("[data-testid=river-bar]")!;
    return Math.abs(bar.getBoundingClientRect().width - bar.parentElement!.getBoundingClientRect().width) < 1;
  });
  expect(full).toBe(true);
});

/** Text drawn over a link: any other visible text whose box crosses the link's. */
const overLink = (page: Page, testId: string) =>
  page.evaluate((id) => {
    const link = document.querySelector<HTMLElement>(`[data-testid=${id}]`);
    if (!link) return [`no ${id}`];
    const p = link.getBoundingClientRect();
    const out: string[] = [];
    if (p.left < 0 || p.right > document.documentElement.clientWidth) out.push(`${id} off the screen`);
    const hit = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left < p.right - 1 && p.left < r.right - 1 && r.top < p.bottom - 1 && p.top < r.bottom - 1;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || link.contains(el) || !(n.textContent ?? "").trim() || getComputedStyle(el).visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (hit(r)) out.push((n.textContent ?? "").trim());
    }
    return [...new Set(out)];
  }, testId);

for (const [label, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
  test.describe(`the Ledger's link to the river at ${label}`, () => {
    test.use({ viewport: { width, height } });
    for (const lang of LANGS) {
      test(`${lang}: next to the poster's link, nothing over either`, async ({ page }) => {
        const v = fixture("closed");
        await page.route(`**/api/drives/${v.drive.id}`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(v) }));
        await page.route("**/api/receipts/*/image", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
        await page.goto(`/drive/${v.drive.id}?as=ledger${lang === "en" ? "" : `&lang=${lang}`}`);
        await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
        await page.waitForTimeout(800);
        const river = page.getByTestId("river-link");
        await expect(river).toHaveCount(1);
        await expect(page.getByTestId("poster-link")).toHaveCount(1);
        await expect(river).toHaveText(RIVER_WORDS[lang].link);
        await expect(river).toHaveAttribute("href", `/drive/${v.drive.id}/river${lang === "en" ? "" : `?lang=${lang}`}`);
        await river.scrollIntoViewIfNeeded();
        await expect(river).toBeVisible();
        expect({ river: await overLink(page, "river-link"), poster: await overLink(page, "poster-link") }).toEqual({ river: [], poster: [] });
      });
    }
  });
}
