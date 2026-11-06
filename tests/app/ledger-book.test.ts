import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveLedger, type LedgerModel } from "@/ui/ledger/derive";
import { bookChanges, FLASH_MS } from "@/ui/ledger/flash";
import { lineProof, stripStyle } from "@/ui/ledger/proof";
import { LedgerStore } from "@/ui/ledger/store";
import { ledgerData } from "@/ui/ledger/studio-state";
import type { DriveView } from "@/ui/types";

// The book's proof band, its flashes and the points the assistant plugs into (store API).

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const closed = fixture("closed");
const open = fixture("open");
const MARK4 = "demo-f372326129.r1:4/demo-f372326129.diapers";

/** The open drive with every share captured: what the next read says after PayPal confirms. */
function captured(v: DriveView): DriveView {
  const out = structuredClone(v);
  out.ledger = out.ledger.map((r) => (r.kind === "donor_share" || r.kind === "match_share" ? { ...r, status: "captured", captureId: `CAP-${r.pledgeId}` } : r));
  return out;
}

describe("the phone's How much column", () => {
  it("shows each payer's share in the payer's own currency, as the desktop Share column and the agent's answer do", () => {
    const source = ledgerData(deriveLedger(closed)).sources.find((s) => s.id === "book") as unknown as { data: { rowKey: string; much: unknown; paid: string }[] };
    const book = source.data;
    const mark4 = book.find((r) => r.rowKey === MARK4)!;
    expect(mark4.much).toBe("$8.58");
    expect(mark4.much).toBe(mark4.paid);
    const match4 = book.find((r) => r.rowKey === "demo-f372326129.r1:4/demo-f372326129.match")!;
    expect(match4.much).toBe("¥1,298");
  });
});

describe("the flash: which rows of the book just changed", () => {
  it("rows PayPal just took flash green; nothing else does", () => {
    const before = deriveLedger(open).book;
    const after = deriveLedger(captured(open)).book;
    const changes = bookChanges(before, after);
    const shares = after.filter((r) => r.kind === "donor_share" || r.kind === "match_share").map((r) => r.rowKey);
    expect([...changes.keys()].sort()).toEqual(shares.sort());
    expect(new Set(changes.values())).toEqual(new Set(["spent"]));
  });

  it("rows whose money came back flash blue", () => {
    const back = structuredClone(closed);
    back.ledger = back.ledger.map((r) => (r.rowId === MARK4 ? { ...r, status: "reversed", reversed: r.amount } : r));
    expect([...bookChanges(deriveLedger(closed).book, deriveLedger(back).book)]).toEqual([[MARK4, "back"]]);
  });

  it("the same book, a new row, or the same book in another language flash nothing", () => {
    expect(bookChanges(deriveLedger(closed).book, deriveLedger(closed).book).size).toBe(0);
    expect(bookChanges(deriveLedger(closed).book, deriveLedger(closed, "ja").book).size).toBe(0);
    expect(bookChanges([], deriveLedger(closed).book).size).toBe(0);
  });
});

describe("the store keeps the flashes, and they outlive a rebuilt report", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a new read marks the changed rows, each with its own id, until the flash is over", () => {
    const store = new LedgerStore(deriveLedger(open), open);
    store.setModel(deriveLedger(captured(open)));
    const flashes = store.get().flashes;
    expect(flashes.size).toBeGreaterThan(0);
    expect(new Set([...flashes.values()].map((f) => f.id)).size).toBe(flashes.size);
    // Studio is rebuilt: whoever reads the store now still sees the flash.
    expect(store.get().flashes).toBe(flashes);
    vi.advanceTimersByTime(FLASH_MS + 10);
    expect(store.get().flashes.size).toBe(0);
  });

  it("switching the language rebuilds the book without flashing it", () => {
    const store = new LedgerStore(deriveLedger(closed), closed);
    store.setLang("de");
    store.setModel(deriveLedger(closed, "de"));
    expect(store.get().lang).toBe("de");
    expect(store.get().flashes.size).toBe(0);
  });

  it("keeps the drive view beside the model", () => {
    const store = new LedgerStore(deriveLedger(open), open);
    expect(store.get().view).toBe(open);
    const next = captured(open);
    store.setView(next);
    expect(store.get().view).toBe(next);
    expect(new LedgerStore(deriveLedger(open)).get().view).toBeNull();
  });
});

describe("the assistant's points into the book", () => {
  const model = deriveLedger(closed);
  const mark = model.donors.find((d) => d.name === "Mark")!;

  it("focusLines narrows the book to the lines, opens it and names the narrowing; clearFocus undoes it", () => {
    const store = new LedgerStore(model, closed);
    const filtered: string[][] = [];
    store.connectFilter((keys) => filtered.push(keys));
    store.focusLines(mark.lineKeys, "Mark · Columbus");
    expect(store.get().focus).toEqual({ lineKeys: mark.lineKeys, label: "Mark · Columbus" });
    expect(store.get().bookOpen).toBe(true);
    expect(filtered.at(-1)).toEqual(mark.lineKeys);
    store.clearFocus();
    expect(store.get().focus).toBeNull();
    expect(filtered.at(-1)).toEqual([]);
  });

  it("a filter connected later (Studio rebuilt) gets the narrowing at once", () => {
    const store = new LedgerStore(model, closed);
    store.focusLines(mark.lineKeys, "Mark");
    let got: string[] | null = null;
    store.connectFilter((keys) => (got = keys));
    expect(got).toEqual(mark.lineKeys);
  });

  it("a donor or need pressed by hand replaces the assistant's narrowing", () => {
    const store = new LedgerStore(model, closed);
    store.focusLines(mark.lineKeys, "Mark");
    store.toggle({ kind: "need", needId: "water" });
    expect(store.get().focus).toBeNull();
  });

  it("clearing a narrowing goes back to what was pressed before it, if anything still is", () => {
    const store = new LedgerStore(model, closed);
    const filtered: string[][] = [];
    store.connectFilter((keys) => filtered.push(keys));
    store.focusLines(["demo-f372326129.r1:10"], "beer");
    store.clearFocus();
    expect(filtered.at(-1)).toEqual([]);
  });

  it("Ask about this line calls the assistant's callback with the line, and there is no button without one", () => {
    const store = new LedgerStore(model, closed);
    expect(store.get().askAbout).toBeNull();
    const asked: string[] = [];
    store.setAskAbout((key) => asked.push(key));
    store.get().askAbout!("demo-f372326129.r1:4");
    expect(asked).toEqual(["demo-f372326129.r1:4"]);
    store.setAskAbout(null);
    expect(store.get().askAbout).toBeNull();
  });

  it("the chat slot holds the assistant's component, and holds nothing until it is given one", () => {
    const store = new LedgerStore(model, closed);
    expect(store.get().askComponent).toBeNull();
    const Ask = () => null;
    store.setAskComponent(Ask);
    expect(store.get().askComponent).toBe(Ask);
  });

  it("a proof band opens on one row of the book at a time, and a second press closes it", () => {
    const store = new LedgerStore(model, closed);
    store.toggleProof(MARK4);
    expect(store.get().proof).toBe(MARK4);
    store.toggleProof("demo-f372326129.r1:5/demo-f372326129.diapers");
    expect(store.get().proof).toBe("demo-f372326129.r1:5/demo-f372326129.diapers");
    store.toggleProof("demo-f372326129.r1:5/demo-f372326129.diapers");
    expect(store.get().proof).toBeNull();
  });

  it("the band's measured height is kept, whole pixels up; the same height again tells nobody", () => {
    const store = new LedgerStore(model, closed);
    expect(store.get().bandPx).toBeNull();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setBandPx(141.2);
    expect(store.get().bandPx).toBe(142);
    store.setBandPx(141.9);
    expect(calls).toBe(1);
    store.setBandPx(0);
    store.setBandPx(Number.NaN);
    expect(store.get().bandPx).toBe(142);
    expect(calls).toBe(1);
  });

  it("every change tells the listeners, so the widgets in Studio's own roots redraw", () => {
    const store = new LedgerStore(model, closed);
    let calls = 0;
    store.subscribe(() => calls++);
    store.focusLines(mark.lineKeys, "Mark");
    store.setAskAbout(() => {});
    store.setAskComponent(() => null);
    store.toggleProof(MARK4);
    store.setLang("ja");
    expect(calls).toBe(5);
  });
});

describe("the proof band of a line", () => {
  const model: LedgerModel = deriveLedger(closed);

  it("Mark's share of line 4: the strip of the printed line, the split with the match, PayPal's capture and its time", () => {
    const p = lineProof(closed, model, MARK4)!;
    expect(p.line).toBe(4);
    expect(p.item).toBe("Soft kids diapers M");
    expect(p.printed).toBe("ソフトキッズおおむつ M 44 枚");
    expect(p.strip).toEqual({ url: "/api/receipts/demo-f372326129.r1/image", box: closed.receipts[0].lines[3].box });
    expect(p.receipt).toBe("ミナト生活館 北空店 · receipt ¥14,646");
    expect(p.sentence).toBe("Line 4 · Soft kids diapers M · ¥2,596 = Mark · Columbus $8.58 (¥1,298) + Kitasora Logistics match ¥1,298");
    expect(p.capture).toEqual({ id: "5PE922386K0983923", state: "Completed", at: "Nov 1, 02:06 UTC" });
    expect(p.matchCapture).toBe("64424341AL727524D");
    expect(p.reason).toBeNull();
  });

  it("a refused line says why, and no capture", () => {
    const p = lineProof(closed, model, "demo-f372326129.r1:10/rejected")!;
    expect(p.sentence).toBe("Line 10 · Alcohol · ¥1,198 — Alcohol is not funded.");
    expect(p.capture).toEqual({ id: null, state: "No capture", at: null });
    expect(p.matchCapture).toBeNull();
    expect(p.reason).toBe("Alcohol is not funded.");
  });

  it("no box, or no published photo: no strip, never another line's", () => {
    const noBox = structuredClone(closed);
    noBox.receipts[0].lines[3].box = null;
    expect(lineProof(noBox, deriveLedger(noBox), MARK4)!.strip).toBeNull();
    const unpublished = structuredClone(closed);
    unpublished.receipts[0].image = { published: false, note: "Not published." } as never;
    expect(lineProof(unpublished, deriveLedger(unpublished), MARK4)!.strip).toBeNull();
  });

  it("in German and Japanese", () => {
    const de = lineProof(closed, deriveLedger(closed, "de"), MARK4, "de")!;
    expect(de.sentence).toBe("Zeile 4 · Soft kids diapers M · 2.596 ¥ = Mark · Columbus 8,58 $ (1.298 ¥) + Kitasora Logistics Zuschuss 1.298 ¥");
    expect(de.capture.at).toBe("1. Nov., 02:06 UTC");
    const ja = lineProof(closed, deriveLedger(closed, "ja"), MARK4, "ja")!;
    expect(ja.capture).toEqual({ id: "5PE922386K0983923", state: "完了", at: "11月1日 02:06 UTC" });
    expect(ja.receipt).toBe("ミナト生活館 北空店 · レシート ¥14,646");
  });

  it("an unknown row has no band", () => {
    expect(lineProof(closed, model, "nope")).toBeNull();
  });

  it("the strip shows exactly the box, as large as fits, never stretched", () => {
    const box = { x: 0.2, y: 0.5, w: 0.5, h: 0.025 };
    // A 400 × 800 photo: the box is 200 × 20 px and starts 80 px in, 400 px down.
    expect(stripStyle(box, { width: 400, height: 800 }, 200, 40)).toEqual({ width: 200, height: 20, backgroundSize: "400px 800px", backgroundPosition: "-80px -400px" });
    // Half the room: half the size, the same proportions.
    expect(stripStyle(box, { width: 400, height: 800 }, 100, 40)).toEqual({ width: 100, height: 10, backgroundSize: "200px 400px", backgroundPosition: "-40px -200px" });
    // Height is the limit: the strip keeps the box's shape.
    expect(stripStyle(box, { width: 400, height: 800 }, 400, 10)).toEqual({ width: 100, height: 10, backgroundSize: "200px 400px", backgroundPosition: "-40px -200px" });
  });
});
