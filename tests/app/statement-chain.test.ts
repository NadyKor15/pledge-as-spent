import { describe, expect, it } from "vitest";
import { METER_KEYS } from "@/ui/hold-meter";
import { chainMeter, chainOf, chainStory, latestMember, type StatementChain } from "@/ui/statement/chain";

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
    expect(story[2]).toMatch(/first hold ended.*nothing was charged twice/);
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
