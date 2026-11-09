import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLedger } from "@/ui/ledger/derive";
import { lineProof } from "@/ui/ledger/proof";
import { lineSentence, linesRegion, markStyle, photoStyle, receiptPanel } from "@/ui/ledger/receipt-panel";
import { focusOf, linesOf, LedgerStore, same } from "@/ui/ledger/store";
import { ledgerState, RECEIPT_ROWS, receiptBeside, type Metrics } from "@/ui/ledger/studio-state";
import { PANEL_WORDS } from "@/ui/ledger/words-panels";
import type { DriveView } from "@/ui/types";

// T4, the receipt beside the book: a press on a printed line of the photo narrows the book to that line and lights up
// who paid for it, as a press on a donor or a need does. The lines the reader did not place are listed, never drawn.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const closed = fixture("closed");
const open = fixture("open");
const LINE4 = "demo-f372326129.r1:4";
const MARK4 = "demo-f372326129.r1:4/demo-f372326129.diapers";

describe("picking a line of the receipt", () => {
  const model = deriveLedger(closed);
  const mark = model.donors.find((d) => d.name === "Mark")!;

  it("lights up the donors who paid for it and its need, and nobody else", () => {
    const f = focusOf(model, { kind: "line", lineKey: LINE4 })!;
    expect([...f.donors]).toEqual([mark.pledgeId]);
    expect([...f.needs]).toEqual(["diapers"]);
  });

  it("narrows the book to that line: the donor's share and the match's", () => {
    expect(linesOf(model, { kind: "line", lineKey: LINE4 })).toEqual([LINE4]);
    expect(model.book.filter((r) => r.lineKey === LINE4).map((r) => r.payer)).toEqual(["Mark", "Kitasora Logistics"]);
  });

  it("a refused line lights up nobody; a line the book does not have narrows to nothing", () => {
    const beer = focusOf(model, { kind: "line", lineKey: "demo-f372326129.r1:10" })!;
    expect(beer.donors.size).toBe(0);
    expect(focusOf(model, { kind: "line", lineKey: "nope:1" })).toBeNull();
    expect(linesOf(model, { kind: "line", lineKey: "nope:1" })).toEqual([]);
  });

  it("the same line is the same pick, a donor or another line is not", () => {
    expect(same({ kind: "line", lineKey: LINE4 }, { kind: "line", lineKey: LINE4 })).toBe(true);
    expect(same({ kind: "line", lineKey: LINE4 }, { kind: "line", lineKey: "demo-f372326129.r1:5" })).toBe(false);
    expect(same({ kind: "line", lineKey: LINE4 }, { kind: "donor", pledgeId: LINE4 })).toBe(false);
    expect(same(null, null)).toBe(true);
  });

  it("a press filters the book to the line, a second press on it clears, and another pick replaces it", () => {
    const store = new LedgerStore(model);
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    store.toggle({ kind: "line", lineKey: LINE4 });
    expect(store.get().selected).toEqual({ kind: "line", lineKey: LINE4 });
    store.toggle({ kind: "line", lineKey: LINE4 });
    expect(store.get().selected).toBeNull();
    store.toggle({ kind: "line", lineKey: LINE4 });
    store.toggle({ kind: "donor", pledgeId: mark.pledgeId });
    expect(store.get().selected).toEqual({ kind: "donor", pledgeId: mark.pledgeId });
    expect(seen).toEqual([[], [LINE4], [], [LINE4], mark.lineKeys]);
  });
});

describe("the receipt's panel", () => {
  it("one button per line of the book on the published photo, in print order, the refused ones marked", () => {
    const p = receiptPanel(closed, deriveLedger(closed))!;
    expect(p.url).toBe("/api/receipts/demo-f372326129.r1/image");
    expect(p.head).toBe("Receipt · ミナト生活館 北空店 · ¥14,646");
    expect(p.placed.map((x) => x.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(p.unplaced).toEqual([]);
    expect(p.placed.find((x) => x.lineNo === 4)!.label).toBe("Line 4 · ¥2,596");
    expect(p.placed.filter((x) => x.refused).map((x) => x.lineNo)).toEqual([10, 11]);
    expect(p.placed.find((x) => x.lineNo === 10)!.label).toBe("Line 10 · ¥1,198 · refused");
  });

  it("a line without a box is listed under the photo, and no other line's box stands in for it", () => {
    const v = structuredClone(closed);
    v.receipts[0].lines.find((l) => l.lineNo === 7)!.box = null;
    const p = receiptPanel(v, deriveLedger(v))!;
    expect(p.placed.map((x) => x.lineNo)).not.toContain(7);
    expect(p.unplaced.map((x) => [x.lineNo, x.box, x.text])).toEqual([[7, null, "アルカリ乾電池単 3 20 本入"]]);
  });

  it("no published photo, no panel", () => {
    const v = structuredClone(closed);
    v.receipts[0].image = { published: false, note: "kept private" } as never;
    expect(receiptPanel(v, deriveLedger(v))).toBeNull();
    expect(receiptPanel(null, deriveLedger(closed))).toBeNull();
  });

  it("speaks German and Japanese", () => {
    expect(receiptPanel(closed, deriveLedger(closed, "de"), "de")!.placed[3].label).toBe("Zeile 4 · 2.596 ¥");
    expect(receiptPanel(closed, deriveLedger(closed, "ja"), "ja")!.placed[3].label).toBe("4行目 · ¥2,596");
  });

  it("the sentence over the book is the proof band's own", () => {
    const m = deriveLedger(closed);
    expect(lineSentence(closed, m, LINE4)).toBe(lineProof(closed, m, MARK4)!.sentence);
    expect(lineSentence(closed, m, LINE4)).toBe("Line 4 · Soft kids diapers M · ¥2,596 = Mark · Columbus $8.58 (¥1,298) + Kitasora Logistics match ¥1,298");
    expect(lineSentence(closed, m, "demo-f372326129.r1:10")).toContain("Alcohol is not funded");
  });
});

describe("the buttons sit on the line's box", () => {
  it("in percent of the whole photo", () => {
    expect(markStyle({ x: 0.2, y: 0.375, w: 0.6, h: 0.02 }, { x: 0, y: 0, w: 1, h: 1 })).toEqual({ left: "20%", top: "37.5%", width: "60%", height: "2%" });
    expect(photoStyle({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ width: "100%", left: "0%", top: "0%" });
  });

  it("in percent of the part with the lines, when only that part shows", () => {
    const region = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
    expect(markStyle({ x: 0.2, y: 0.45, w: 0.4, h: 0.05 }, region)).toEqual({ left: "12.5%", top: "50%", width: "50%", height: "10%" });
    expect(photoStyle(region)).toEqual({ width: "125%", left: "-12.5%", top: "-40%" });
  });

  it("that part holds every placed line, inside the photo", () => {
    const p = receiptPanel(closed, deriveLedger(closed))!;
    for (const { box } of p.placed) {
      expect(box!.x).toBeGreaterThanOrEqual(p.region.x);
      expect(box!.y).toBeGreaterThanOrEqual(p.region.y);
      expect(box!.x + box!.w).toBeLessThanOrEqual(p.region.x + p.region.w + 1e-9);
      expect(box!.y + box!.h).toBeLessThanOrEqual(p.region.y + p.region.h + 1e-9);
    }
    expect(linesRegion([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const edge = linesRegion([{ x: 0, y: 0.99, w: 1, h: 0.01 }]);
    expect([edge.x, edge.w]).toEqual([0, 1]);
    expect(edge.y).toBeCloseTo(0.96, 9);
    expect(edge.y + edge.h).toBeCloseTo(1, 9);
  });
});

describe("where the receipt sits", () => {
  const metrics = (beside: boolean, stacked = false): Metrics => ({
    rowHeight: 10,
    stacked,
    scale: 1,
    beside,
    rows: { kpi: 19, pair: 0, match: 4, note: 0, map: 56, shelter: 56, donors: stacked ? 30 : 0, footer: 9, ask: 46, receipt: stacked ? RECEIPT_ROWS.phone : beside ? RECEIPT_ROWS.beside : RECEIPT_ROWS.over, head: 6, book: 120 },
  });
  const layout = (v: DriveView, m: Metrics) => ledgerState(deriveLedger(v), m).pages[0].widgetLayout! as Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number }>;

  it("beside the open book at the reference size: 12 tracks on the left, the book's head and grid the other 36", () => {
    const l = layout(closed, metrics(true));
    expect(l.receipt).toMatchObject({ xTrack: 0, xSpan: 12, ySpan: RECEIPT_ROWS.beside });
    expect(l["book-head"]).toMatchObject({ xTrack: 12, xSpan: 36, yTrack: l.receipt.yTrack });
    expect(l.book).toMatchObject({ xTrack: 12, xSpan: 36 });
  });

  it("over the book, the whole width, on a narrower desktop and on a phone", () => {
    for (const m of [metrics(false), metrics(false, true)]) {
      const l = layout(closed, m);
      expect(l.receipt).toMatchObject({ xTrack: 0, xSpan: 48 });
      expect(l["book-head"]).toMatchObject({ xTrack: 0, xSpan: 48, yTrack: l.receipt.yTrack + l.receipt.ySpan });
    }
  });

  it("its place and height do not depend on the drive's data", () => {
    for (const m of [metrics(true), metrics(false), metrics(false, true)]) {
      const v = structuredClone(closed);
      v.receipts[0].lines.forEach((l) => (l.box = null));
      expect(layout(open, m).receipt).toEqual(layout(closed, m).receipt);
      expect(layout(v, m).receipt).toEqual(layout(closed, m).receipt);
    }
  });

  it("beside only while the book keeps its columns' least width", () => {
    expect(receiptBeside(1, 1012)).toBe(true);
    expect(receiptBeside(0.95, 1012)).toBe(false);
    expect(receiptBeside(1.2, 1012)).toBe(true);
  });
});

describe("the panels' words", () => {
  it("every key in every language", () => {
    const keys = Object.keys(PANEL_WORDS.en).sort();
    for (const lang of ["de", "ja"] as const) expect(Object.keys(PANEL_WORDS[lang]).sort()).toEqual(keys);
    for (const lang of ["en", "de", "ja"] as const) for (const [k, v] of Object.entries(PANEL_WORDS[lang])) expect(typeof v === "function" ? v.length : v.length, `${lang}.${k}`).toBeGreaterThan(0);
  });
});
