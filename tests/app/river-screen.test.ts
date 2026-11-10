import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import DriveRiverPage from "@/app/drive/[id]/river/page";
import { deriveLedger } from "@/ui/ledger/derive";
import { PosterLink } from "@/ui/ledger/PosterLink";
import { riverOn } from "@/ui/river/flag";
import { riverModel } from "@/ui/river/model";
import { clock, drawRibbons, gapWidth, payoutStatus, REST_MAX, riverLinks, Sums, trunkBase } from "@/ui/river/RiverScreen";
import { RIVER_WORDS, runs } from "@/ui/river/words";
import type { DriveView } from "@/ui/types";

// The river of money (variant A): the switch (NEXT_PUBLIC_RIVER), the Ledger's link to it, its words and its ribbons.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const before = process.env.NEXT_PUBLIC_RIVER;
afterEach(() => {
  if (before === undefined) delete process.env.NEXT_PUBLIC_RIVER;
  else process.env.NEXT_PUBLIC_RIVER = before;
});

describe("the switch", () => {
  it('only "on" switches the river on', () => {
    for (const v of ["on", "ON", " on "]) expect(riverOn(v)).toBe(true);
    for (const v of ["", "off", "1", "true", "yes", null, undefined]) expect(riverOn(v)).toBe(false);
  });

  it("switched off, the page is not found; switched on, it renders", () => {
    const params = Promise.resolve({ id: "demo-f372326129" });
    delete process.env.NEXT_PUBLIC_RIVER;
    let digest = "";
    try {
      DriveRiverPage({ params } as never);
    } catch (e) {
      digest = String((e as { digest?: string }).digest);
    }
    expect(digest).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    process.env.NEXT_PUBLIC_RIVER = "on";
    expect(() => DriveRiverPage({ params } as never)).not.toThrow();
  });
});

describe("the Ledger's link to the river", () => {
  const render = (lang: "en" | "de" | "ja", className = "lg-poster-link") => renderToStaticMarkup(createElement(PosterLink, { driveId: "demo-f372326129", lang, className }));

  it("switched off: the poster's link alone, byte for byte as before the river", () => {
    delete process.env.NEXT_PUBLIC_RIVER;
    expect(render("de")).toBe('<a class="lg-poster-link" href="/drive/demo-f372326129/poster?lang=de" data-testid="poster-link">Plakat für die Unterkunft</a>');
    expect(render("en", "lg-csv lg-poster-foot")).toBe('<a class="lg-csv lg-poster-foot" href="/drive/demo-f372326129/poster" data-testid="poster-link">Poster for the shelter</a>');
    process.env.NEXT_PUBLIC_RIVER = "off";
    expect(render("ja")).not.toContain("river");
  });

  it("switched on: the river's link next to the poster's, in the book's language", () => {
    process.env.NEXT_PUBLIC_RIVER = "on";
    const html = render("de");
    expect(html).toContain('data-testid="poster-link"');
    expect(html).toContain('href="/drive/demo-f372326129/poster?lang=de"');
    expect(html).toMatch(/<a class="rv-links-a" href="\/drive\/demo-f372326129\/river\?lang=de" data-testid="river-link">Geldfluss<\/a>/);
    expect(html).toMatch(/^<span class="lg-poster-link rv-links"/);
    expect(render("en")).toContain('href="/drive/demo-f372326129/river"');
  });
});

describe("words", () => {
  it("line numbers as runs", () => {
    expect(runs([3, 1, 2])).toBe("1–3");
    expect(runs([4])).toBe("4");
    expect(runs([1, 2, 3, 5, 7, 8])).toBe("1–3, 5, 7–8");
    expect(RIVER_WORDS.en.lineNos([1, 2, 3])).toBe("lines 1–3");
    expect(RIVER_WORDS.en.lineNos([4])).toBe("line 4");
    expect(RIVER_WORDS.ja.lineNos([7, 8, 9])).toBe("7–9行目");
  });

  it("the closing line names the drive's currency, not always yen", () => {
    expect(RIVER_WORDS.en.traced("JPY")).toBe("Every yen traced from the receipt to PayPal.");
    expect(RIVER_WORDS.en.traced("USD")).toContain("Every dollar");
    expect(RIVER_WORDS.en.traced("EUR")).toContain("Every euro");
    expect(RIVER_WORDS.en.traced("CHF")).toContain("Every amount");
    expect(RIVER_WORDS.de.traced("EUR")).toContain("Jeder Euro");
    expect(RIVER_WORDS.ja.traced("JPY")).toContain("1円残らず");
    expect(RIVER_WORDS.ja.traced("USD")).toContain("1ドル残らず");
  });

  it("every language has every word", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(RIVER_WORDS.de)).toEqual(keys(RIVER_WORDS.en));
    expect(keys(RIVER_WORDS.ja)).toEqual(keys(RIVER_WORDS.en));
  });

  it("the clock and PayPal's payout status", () => {
    expect(clock(0)).toBe("0:00 / 0:20");
    expect(clock(12)).toBe("0:12 / 0:20");
    expect(clock(20)).toBe("0:20 / 0:20");
    expect(payoutStatus("confirmed")).toBe("SUCCESS");
    expect(payoutStatus("failed")).toBe("FAILED");
  });
});

describe("the sums under the river", () => {
  const twoReceipts = () => {
    const v = fixture("closed");
    const r1 = v.receipts[0].id;
    const r0 = { ...v.receipts[0], id: `${r1}0` };
    v.receipts = [r0, ...v.receipts];
    v.ledger = [...v.ledger.filter((r) => r.receiptId === r1).map((r) => ({ ...r, receiptId: r0.id, rowId: `${r.rowId}0` })), ...v.ledger];
    return v;
  };
  const html = (v: DriveView) => renderToStaticMarkup(createElement(Sums, { m: riverModel(v, "en"), w: RIVER_WORDS.en, lang: "en" }));

  it("one receipt: one line, the rests in it", () => {
    const h = html(fixture("closed"));
    expect(h).not.toContain("On this receipt:");
    expect(h).not.toContain("river-rests");
    expect(h).toMatch(/data-testid="river-sums".*data-sum="never"/);
  });

  it("several receipts: this receipt's sums, and the holds' rests on a line of their own", () => {
    const h = html(twoReceipts());
    const [sums, rests] = h.split('data-testid="river-rests"');
    expect(sums).toContain("On this receipt:");
    expect(sums).not.toContain('data-sum="never"');
    expect(rests).toContain("Holds released:");
    expect(rests).toContain('data-sum="never"');
  });

  it("a rest that only came back as a refund draws no ribbon", () => {
    const v = fixture("closed");
    Object.assign(v.holds.find((h) => h.pledgeId === "demo-f372326129.diapers")!, { released: 0, reversed: 855 });
    const ids = riverLinks(riverModel(v, "en"), "x").filter((l) => l.kind === "never").map((l) => l.id);
    expect(ids).toEqual(["nv:demo-f372326129.water", "nv:demo-f372326129.batteries"]);
  });
});

describe("a rest bigger than the receipt", () => {
  it("draws capped: at most half the widest ribbon on a desktop, 44 px on a phone; its card keeps the exact sum", () => {
    const v = fixture("closed");
    // Lena pledged €5,000 for a €4.58 share: her rest is many times the receipt.
    Object.assign(v.holds.find((h) => h.pledgeId === "demo-f372326129.water")!, { authorized: 500000, pledged: 500000, released: 500000 - 458 });
    const m = riverModel(v, "en");
    const lena = m.never.find((n) => n.pledgeId === "demo-f372326129.water")!;
    expect(lena.base).toBeGreaterThan(trunkBase(m));
    expect(lena.text).toBe("€4,995.42");
    const rests = riverLinks(m, "x").filter((l) => l.kind === "never");
    const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
    rests.forEach((l, i) => {
      boxes.set(l.from, { x: 400, y: i * 120, w: 150, h: 70 });
      boxes.set(l.to as string, { x: 400 + i * 230, y: 600, w: 210, h: 50 });
    });
    const drawn = drawRibbons(rests, boxes, 80 / trunkBase(m));
    expect(drawn).toHaveLength(3);
    expect(Math.max(...drawn.map((d) => d.stroke ?? 0))).toBe(REST_MAX.desktop);
    expect(gapWidth(lena.base, REST_MAX.phone / trunkBase(m))).toBe(REST_MAX.phone);
  });
});

describe("the ribbons", () => {
  const v = fixture("closed");
  const m = riverModel(v, "en");

  it("the sums under the river are the Ledger's: spent, match, payout, never charged", () => {
    const l = deriveLedger(v, "en");
    expect(m.totals.donorBase).toBe(l.spent);
    expect(m.totals.matchBase).toBe(l.match);
    expect(m.totals.payoutBase).toBe(l.spent + l.match);
    expect(m.totals.neverBase).toBe(l.returned);
  });

  it("every amount flows on: what enters a card leaves it (refused lines end in a stub)", () => {
    const links = riverLinks(m, "x");
    const sum = (xs: { base: number }[]) => xs.reduce((a, x) => a + x.base, 0);
    const into = (node: string) => sum(links.filter((l) => l.to === node));
    const outOf = (node: string) => sum(links.filter((l) => l.from === node && l.kind !== "never"));
    expect(into("read")).toBe(outOf("read"));
    expect(into("read")).toBe(14646);
    for (const n of m.needs) expect(into(`need:${n.needId}`)).toBe(outOf(`need:${n.needId}`));
    expect(into("payout")).toBe(m.payout!.amount);
    expect(links.filter((l) => l.to === null).map((l) => l.id)).toEqual(["stub:demo-f372326129.r1:10/rejected", "stub:demo-f372326129.r1:11/rejected"]);
    expect(sum(links.filter((l) => l.kind === "never"))).toBe(m.totals.neverBase);
    // The match's shares go to its own hold, not to the refused lines.
    const matchHold = m.holds.find((h) => h.kind === "match")!;
    expect(links.filter((l) => l.to === `hold:${matchHold.pledgeId}`).map((l) => l.base)).toEqual([743, 3244, 1237]);
  });

  it("a ribbon is as thick as its amount, stacked on its card's edge in the order of where it goes", () => {
    const links = riverLinks(m, "x").filter((l) => l.from === "read" || l.id === "trunk");
    const boxes = new Map<string, { x: number; y: number; w: number; h: number }>([
      ["receipt", { x: 0, y: 200, w: 100, h: 200 }],
      ["read", { x: 200, y: 250, w: 100, h: 100 }],
      ...m.needs.map((n, i) => [`need:${n.needId}`, { x: 400, y: i * 100, w: 100, h: 40 }] as const),
      ...m.refused.map((r, i) => [`ref:${r.key}`, { x: 400, y: 400 + i * 100, w: 100, h: 40 }] as const),
    ]);
    const per = 80 / 14646;
    const drawn = drawRibbons(links, boxes, per);
    expect(drawn).toHaveLength(links.length);
    const start = (id: string) => Number(/^M[\d.]+ ([\d.]+)/.exec(drawn.find((d) => d.id === id)!.d)![1]);
    // Leaving "read": water on top, then diapers, batteries, the two refused lines; together the trunk's thickness.
    const [beer, gift] = m.refused.map((r) => `rr:${r.key}`);
    const order = ["rn:water", "rn:diapers", "rn:batteries", beer, gift].map(start);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[0]).toBeCloseTo(300 - 40, 0);
    expect(start(beer) - start("rn:batteries")).toBeCloseTo(2474 * per, 1);
  });
});
