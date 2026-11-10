import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLedger } from "@/ui/ledger/derive";
import { readTwice, riverModel } from "@/ui/river/model";
import type { DriveView } from "@/ui/types";

// The river (П2, variant A) adds up to the Ledger at every step: what the lines cost = the shares; the donors' shares =
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
    for (const r of ["cached:ocr-pro", "recorded", "copy", "live:nova-lite", "", null, undefined]) expect(readTwice(r)).toBe(false);
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
