import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLedger } from "@/ui/ledger/derive";
import { readTwice, riverModel } from "@/ui/river/model";
import type { DriveView } from "@/ui/types";

// The river of money (variant A) adds up to the Ledger at every step: what the lines cost = the shares; the donors' shares =
// the Ledger's "donors' money spent"; donors + match = the payout; the released rests = the Ledger's "never charged".

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;

describe("the river of the closed demo drive", () => {
  const v = fixture("closed");
  const m = riverModel(v, "en");
  const l = deriveLedger(v, "en");

  it("one receipt, three needs over lines 1–3, 4–6, 7–9, two refused lines", () => {
    expect(m.receipt).toMatchObject({ total: 14646, lines: 11 });
    expect(m.needs.map((n) => [n.needId, n.lineNos])).toEqual([
      ["water", [1, 2, 3]],
      ["diapers", [4, 5, 6]],
      ["batteries", [7, 8, 9]],
    ]);
    expect(m.refused.map((r) => [r.lineNo, r.base])).toEqual([
      [10, 1198],
      [11, 3000],
    ]);
  });

  it("each need is split between its donor and the match; the match's shares are in yen (¥743 / ¥3,244 / ¥1,237)", () => {
    const match = m.needs.map((n) => n.shares.find((s) => s.kind === "match")?.text);
    expect(match).toEqual(["¥743", "¥3,244", "¥1,237"]);
    const donors = m.needs.map((n) => n.shares.find((s) => s.kind === "donor")?.text);
    expect(donors).toEqual(["€4.58", "$21.45", "¥1,237"]);
  });

  it("every step adds up to the Ledger", () => {
    expect(m.totals.sharesBase).toBe(m.totals.donorBase + m.totals.matchBase);
    expect(m.totals.donorBase).toBe(l.spent);
    expect(m.totals.donorBase + m.totals.matchBase).toBe(m.totals.payoutBase);
    expect(m.totals.payoutBase).toBe(10448);
    expect(m.totals.neverBase).toBe(l.returned);
    expect(m.totals.sharesBase + m.totals.refusedBase).toBe(m.receipt!.total);
    for (const n of m.needs) expect(n.shares.reduce((a, s) => a + s.base, 0)).toBe(n.base);
  });

  it("holds carry PayPal's own ids: the authorization and this receipt's captures", () => {
    const lena = m.holds.find((h) => h.who.startsWith("Lena"))!;
    expect(lena).toMatchObject({ authorizationId: "2Y816602392541815", authorizedText: "€20.00", capturedText: "€4.58", captureIds: ["3WP65983GD053501C"] });
    expect(m.holds.filter((h) => h.kind === "match")).toHaveLength(1);
    expect(m.payout).toMatchObject({ batchId: "NPUW3BEC9J8TC", to: "Haruto", text: "¥10,448" });
  });

  it("the rest never charged: one per donor, in the donor's currency (€15.42 / $8.55 / ¥1,763), the match's own rest left out", () => {
    expect(m.never.map((n) => n.text)).toEqual(["€15.42", "$8.55", "¥1,763"]);
    expect(m.never.every((n) => !n.who.startsWith("Kitasora"))).toBe(true);
  });

  it("the fixture was read by the old pipeline: no claim of two readings", () => {
    expect(m.twoReadings).toBe(false);
  });
});

describe("two readings only on Meta's path", () => {
  it("live/cached/recognized:meta read twice; anything else does not", () => {
    for (const r of ["live:meta", "cached:meta", "recognized:meta"]) expect(readTwice(r)).toBe(true);
    for (const r of ["cached:ocr-pro", "recorded", "copy", "live:other", "", null, undefined]) expect(readTwice(r)).toBe(false);
  });

  it("a Meta-read receipt says so", () => {
    const v = fixture("closed");
    v.receipts = v.receipts.map((r) => ({ ...r, reader: "cached:meta" }));
    expect(riverModel(v).twoReadings).toBe(true);
  });
});

describe("the river of the open drive", () => {
  const v = fixture("open");
  const m = riverModel(v, "en");
  const l = deriveLedger(v, "en");

  it("live holds: nothing never charged yet; the shares still add up to the Ledger", () => {
    expect(m.never).toEqual([]);
    expect(m.totals.donorBase).toBe(l.spent);
    expect(m.totals.sharesBase).toBe(m.totals.donorBase + m.totals.matchBase);
  });
});

// ── Cases the demo drives do not have, made from the closed demo drive (a refund, a second receipt, a share PayPal
// could not collect, an unfunded line, part of a line, a pending payout, a rest bigger than the receipt). Each one adds
// up to the Ledger or to the receipt's total.

const DIAPERS = "demo-f372326129.diapers";
const WATER = "demo-f372326129.water";
const BATTERIES = "demo-f372326129.batteries";
const R1 = "demo-f372326129.r1";
const holdOf = (v: DriveView, id: string) => v.holds.find((h) => h.pledgeId === id)!;
const trunk = (m: ReturnType<typeof riverModel>) => m.totals.grossBase + m.totals.refusedBase + m.totals.unfundedBase;

describe("a refund after the capture (partly_reversed)", () => {
  // Mark's line 4 share: $8.58 captured, $1.00 refunded by PayPal.
  const v = fixture("closed");
  const row = v.ledger.find((r) => r.lineNo === 4 && r.pledgeId === DIAPERS)!;
  row.status = "partly_reversed";
  row.reversed = 100;
  Object.assign(holdOf(v, DIAPERS), { captured: 2045, reversed: 100 });
  const m = riverModel(v, "en");
  const l = deriveLedger(v, "en");

  it("the shares count net of the refund, at the Ledger's rate: the donors' sum is the Ledger's spent", () => {
    expect(m.totals.donorBase).toBe(l.spent);
    expect(m.totals.donorBase).toBe(5224 - 151);
    const mark = m.needs.find((n) => n.needId === "diapers")!.shares.find((s) => s.kind === "donor")!;
    expect(mark).toMatchObject({ amount: 2045, text: "$20.45", returned: 100, returnedText: "$1.00" });
  });

  it("the refund is returned, not never charged; with the released rest it is the Ledger's figure", () => {
    const rest = m.never.find((n) => n.pledgeId === DIAPERS)!;
    expect(rest).toMatchObject({ text: "$8.55", returnedText: "$1.00", returnedBase: 151, base: 1292 });
    expect(m.totals.neverBase + m.totals.returnedBase).toBe(l.returned);
    expect(m.totals.returnedBase).toBe(151);
  });

  it("the receipt still adds up: what the lines cost flows in, whatever came back later", () => {
    expect(trunk(m)).toBe(m.receipt!.total);
  });
});

describe("a drive with two paid receipts", () => {
  // The same purchase twice: r0 before r1. The river follows r1; each hold also paid for r0.
  const v = fixture("closed");
  const r0 = { ...v.receipts[0], id: "demo-f372326129.r0" };
  v.receipts = [r0, ...v.receipts];
  v.ledger = [...v.ledger.filter((r) => r.receiptId === R1).map((r) => ({ ...r, receiptId: r0.id, rowId: r.rowId.replace(R1, r0.id), captureId: r.captureId ? `${r.captureId}0` : null })), ...v.ledger];
  // Mark's hold big enough for both ($30 → $60); every hold took this receipt's shares twice.
  Object.assign(holdOf(v, DIAPERS), { authorized: 6000, pledged: 6000, released: 6000 - 2145 });
  for (const h of v.holds) Object.assign(h, { captured: h.captured * 2, released: h.released - h.captured });
  const m = riverModel(v, "en");
  const l = deriveLedger(v, "en");

  it("says the sums are this receipt's, and they are: half of the Ledger's", () => {
    expect(m.receipts).toBe(2);
    expect(m.receipt!.id).toBe(R1);
    expect(m.totals.donorBase).toBe(5224);
    expect(l.spent).toBe(2 * 5224);
    expect(trunk(m)).toBe(m.receipt!.total);
  });

  it("each hold names its other receipts: this receipt + the others = what the Ledger says the donor spent", () => {
    for (const h of m.holds.filter((x) => x.kind === "donor")) {
      const d = l.donors.find((x) => x.pledgeId === h.pledgeId)!;
      expect(h.otherReceipts).toBe(h.captured);
      expect(h.captured + h.otherReceipts).toBe(d.spent);
    }
    expect(m.holds.find((h) => h.pledgeId === WATER)!.otherText).toBe("€4.58");
  });
});

describe("a share PayPal could not collect", () => {
  // Yuki's batteries: all three shares uncollected; the hold released the rest.
  const v = fixture("closed");
  for (const r of v.ledger.filter((x) => x.pledgeId === BATTERIES)) Object.assign(r, { status: "uncollected", captureId: null, code: "uncollected" });
  Object.assign(holdOf(v, BATTERIES), { captured: 0, uncollected: 1237 });
  const m = riverModel(v, "en");
  const l = deriveLedger(v, "en");

  it("is not spent, not waiting: the hold says PayPal could not collect it", () => {
    const yuki = m.holds.find((h) => h.pledgeId === BATTERIES)!;
    expect(yuki).toMatchObject({ state: "uncollected", captureIds: [], capturedBase: 0, uncollected: 1237, uncollectedText: "¥1,237" });
    expect(m.needs.find((n) => n.needId === "batteries")!.shares.find((s) => s.kind === "donor")!.state).toBe("uncollected");
    expect(m.totals.donorBase).toBe(l.spent);
    expect(m.totals.neverBase + m.totals.returnedBase).toBe(l.returned);
  });
});

describe("unfunded lines and part of a line", () => {
  // Line 11 left unfunded (not enough pledges); line 6 only part funded: ¥100 of it refused (need covered).
  const v = fixture("closed");
  Object.assign(v.ledger.find((r) => r.lineNo === 11)!, { kind: "unfunded", status: "unfunded", code: "not_enough_pledges", rowId: `${R1}:11/unfunded` });
  v.ledger.find((r) => r.lineNo === 10)!.base -= 100;
  v.ledger.push({ ...v.ledger.find((r) => r.lineNo === 10)!, lineNo: 6, base: 100, code: "need_covered", rowId: `${R1}:6/need_covered`, needId: "diapers" });
  const m = riverModel(v, "en");

  it("shows them, as refusals: the trunk is shares + refused + unfunded = the receipt's total", () => {
    expect(m.refused.map((r) => [r.lineNo, r.kind, r.part, r.base])).toEqual([
      [6, "rejected", true, 100],
      [10, "rejected", false, 1098],
      [11, "unfunded", false, 3000],
    ]);
    expect(m.refused[0].item).toBeNull();
    expect(m.totals.unfundedBase).toBe(3000);
    expect(trunk(m)).toBe(m.receipt!.total);
  });
});

describe("a payout PayPal has not confirmed", () => {
  const v = fixture("closed");
  Object.assign(v.payouts[0].attempts[0], { status: "pending", payoutBatchId: null });
  const m = riverModel(v, "en");

  it("is shown with its status; nothing counts as paid out", () => {
    expect(m.payout).toMatchObject({ confirmed: false, status: "pending" });
    expect(m.totals.payoutBase).toBe(0);
  });
});

describe("the closing sentence and the donors' word", () => {
  it("nothing more can be charged only on a closed drive whose every hold is over", () => {
    expect(riverModel(fixture("closed")).final).toBe(true);
    expect(riverModel(fixture("open")).final).toBe(false);
    const v = fixture("closed");
    holdOf(v, WATER).status = "authorized";
    expect(riverModel(v).final).toBe(false);
  });

  it("the donors' money takes the Ledger's own word: approved while it waits for capture", () => {
    for (const name of ["closed", "open"] as const) {
      const v = fixture(name);
      for (const lang of ["en", "de", "ja"] as const) expect(riverModel(v, lang).spentLabel).toBe(deriveLedger(v, lang).spentLabel);
    }
  });
});

describe("the match's share in the drive's currency", () => {
  it("whatever the currency of its hold", () => {
    const v = fixture("closed");
    for (const r of v.ledger.filter((x) => x.kind === "match_share")) Object.assign(r, { currency: "USD", amount: Math.round(r.base / 1.512) });
    Object.assign(holdOf(v, "demo-f372326129.match"), { currency: "USD" });
    const m = riverModel(v, "en");
    expect(m.needs.map((n) => n.shares.find((s) => s.kind === "match")!.text)).toEqual(["¥743", "¥3,244", "¥1,237"]);
  });
});

describe("languages", () => {
  it("German and Japanese read the same numbers", () => {
    const v = fixture("closed");
    const en = riverModel(v, "en");
    for (const lang of ["de", "ja"] as const) {
      const m = riverModel(v, lang);
      expect(m.totals).toEqual(en.totals);
      expect(m.needs.map((n) => n.lineNos)).toEqual(en.needs.map((n) => n.lineNos));
    }
  });
});
