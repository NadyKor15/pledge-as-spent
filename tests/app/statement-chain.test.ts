import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { statementRowsToTranslate } from "@/server/translations";
import { METER_KEYS } from "@/ui/hold-meter";
import { chainMeter, chainOf, chainRows, chainStory, latestMember, type StatementChain } from "@/ui/statement/chain";
import { statementLines } from "@/ui/statement/lines";
import type { DriveView, Statement } from "@/ui/types";

// P3FL's example of the statement's `chain` (p3fl3 7b133f1, src/core/renew.ts chainStatement): Lena pledged €20.00,
// renewed on day 27, and the new hold already pays a line.
const lena: StatementChain = {
  first: "lena",
  latest: "r1",
  currency: "EUR",
  members: [
    { pledgeId: "lena", status: "voided", authorized: 2000, usable: null, captured: 333, released: 1667, expiresAt: "2026-12-08T10:00:00.000Z", renewedAt: null, renews: null, renewedTo: "r1" },
    { pledgeId: "r1", status: "authorized", authorized: 1667, usable: 1667, captured: 0, released: 0, expiresAt: "2027-01-05T10:00:00.000Z", renewedAt: "2026-12-06T10:00:00.000Z", renews: "lena", renewedTo: null },
  ],
  events: [
    { at: "2026-11-09T10:00:00.000Z", kind: "pledged", pledgeId: "lena", note: "" },
    { at: "2026-12-06T10:00:00.000Z", kind: "renewed", pledgeId: "r1", note: "" },
    { at: "2026-12-06T10:01:00.000Z", kind: "ended", pledgeId: "lena", note: "" },
  ],
  rows: [],
  totals: { pledged: 2000, charged: 333, waiting: 333, held: 1334, returning: 0, never: 0, back: 0, uncollected: 0 },
};

describe("a renewed pledge's statement", () => {
  it("no chain without a renewal: the key absent (RENEW off), null, or a chain of one hold", () => {
    expect(chainOf({})).toBeNull();
    expect(chainOf({ chain: null })).toBeNull();
    expect(chainOf({ chain: { ...lena, members: lena.members.slice(0, 1) } })).toBeNull();
    expect(chainOf({ chain: lena })).toBe(lena);
  });

  it("one bar over the chain: the core's totals, adding up to what she pledged (not the two holds' sum)", () => {
    const m = chainMeter(lena);
    expect(m.total).toBe(2000);
    expect(METER_KEYS.reduce((a, k) => a + m[k], 0)).toBe(m.total);
    expect(m.total).toBeLessThan(lena.members[0].authorized + lena.members[1].authorized);
    expect({ charged: m.charged, waiting: m.waiting, held: m.held, never: m.never }).toEqual({ charged: 333, waiting: 333, held: 1334, never: 0 });
  });

  it("the story: pledged, renewed with what the new hold keeps, the first hold ended without a second charge", () => {
    const story = chainStory(lena).map((l) => l.text);
    expect(story).toHaveLength(3);
    expect(story[0]).toMatch(/you pledged €20\.00/);
    expect(story[1]).toMatch(/renewed\. .*keeps the €16\.67 not spent yet/);
    expect(story[2]).toMatch(/first hold ended.*Nothing was charged twice, and never more than you pledged in all\./);
    // the first hold has ended: no word about seeing two holds
    expect(story[1]).not.toMatch(/both holds/);
  });

  it("while the first hold is not released yet, the renewal says PayPal may show both holds: a hold, not a charge", () => {
    const early: StatementChain = { ...lena, events: lena.events.filter((e) => e.kind !== "ended") };
    const story = chainStory(early).map((l) => l.text);
    expect(story).toHaveLength(2);
    expect(story[1]).toMatch(/may show both holds: that is a hold, not a charge\./);
    expect(story.join(" ")).not.toMatch(/held once/);
    expect(latestMember(lena).pledgeId).toBe("r1");
  });

  it("the chain over: the last hold's end says what was never charged", () => {
    const over: StatementChain = {
      ...lena,
      members: [lena.members[0], { ...lena.members[1], status: "voided", released: 1334 }],
      events: [...lena.events, { at: "2026-12-20T10:00:00.000Z", kind: "ended", pledgeId: "r1", note: "" }],
      totals: { ...lena.totals, waiting: 0, charged: 666, held: 0, never: 1334 },
    };
    expect(chainStory(over).at(-1)!.text).toMatch(/the hold ended\. €13\.34 was never charged/);
  });
});

// The lines of a renewed pledge: Lena's three lines were paid by her FIRST hold; the statement is opened on the new one,
// whose own rows are empty. Each line keeps her share (the chain's rows), never "€0.00". The showcase, demo-810b24be50.
describe("a renewed pledge's lines", () => {
  const showcase = () => (JSON.parse(readFileSync(path.join(__dirname, "../../evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;
  const v = showcase();
  const receipt = v.receipts[0].id;
  const lenaRows = v.ledger
    .filter((r) => r.kind === "donor_share" && r.donorName?.startsWith("Lena"))
    .map((r) => ({ receiptId: r.receiptId, lineNo: r.lineNo, share: { minor: r.amount, currency: r.currency }, pledgeId: "lena" }));
  const newHold = { currency: "EUR", rows: [] } as unknown as Statement;
  const chain: StatementChain = { ...lena, rows: lenaRows };

  it("each line's share over the chain's rows: Lena's €2.46, €1.45, €0.67 from her first hold", () => {
    const lines = statementLines(v, chainRows(newHold, chain), receipt, [1, 2, 3]);
    expect(lines.map((l) => [l.lineNo, l.share])).toEqual([
      [1, 246],
      [2, 145],
      [3, 67],
    ]);
    expect(chainRows(newHold, chain).rows).toHaveLength(lenaRows.length);
  });

  it("without a renewal the statement is the hold's own, the very same object", () => {
    const own = { currency: "EUR", rows: lenaRows } as unknown as Statement;
    expect(chainRows(own, null)).toBe(own);
    expect(chainRows(own, chainOf({ chain: null }))).toBe(own);
  });

  it("the lines to translate: the chain's rows when the answer carries a chain, the statement's own otherwise", () => {
    const own = [{ receiptId: receipt, lineNo: 9 }];
    const all = lenaRows.map((r) => ({ receiptId: r.receiptId, lineNo: r.lineNo as number }));
    expect(statementRowsToTranslate({ statement: { rows: own }, chain: { rows: all } })).toBe(all);
    expect(statementRowsToTranslate({ statement: { rows: own } })).toBe(own);
    expect(statementRowsToTranslate({ statement: { rows: own }, chain: null })).toBe(own);
  });
});
