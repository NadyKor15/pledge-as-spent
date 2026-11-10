import { describe, expect, it, vi } from "vitest";
import { chainRootId, groupByChain, mergeChain } from "../../src/ui/renewal-chain";
import { renewedDrive } from "./support/renewal-fixture";

vi.setConfig({ testTimeout: 60_000 });

describe("one renewed donor as one hold on screens (mergeChain), at every stage", () => {
  // Lena pledged €20.00. Expected parts of her chain, in euro cents, as a hold reader sees them:
  // charged = captured; waiting = accrued + capturePending; can still pay = authorized - charged - waiting - released - uncollected - reversed;
  // never charged = released (+ uncollected once the hold is over).
  const cases = [
    ["renewed", { status: "authorized", authorized: 2000, captured: 333, waiting: 0, rest: 1667, released: 0 }],
    ["captured", { status: "partially_captured", authorized: 2000, captured: 666, waiting: 0, rest: 1334, released: 0 }],
    ["closed", { status: "voided", authorized: 2000, captured: 666, waiting: 0, rest: 0, released: 1334 }],
    // the renewal's €3.33 surplus is held at PayPal but never promised: it is neither "can still pay" nor "never charged"
    ["race", { status: "authorized", authorized: 2000, captured: 333, waiting: 0, rest: 1667, released: 0 }],
  ] as const;
  for (const [stage, want] of cases) {
    it(`${stage}: Lena counted once, ${JSON.stringify(want)}`, async () => {
      const f = await renewedDrive(stage);
      const chains = groupByChain(f.view.holds);
      expect(chains).toHaveLength(f.view.holds.length - 1);
      const m = mergeChain(chains.find((c) => c.root.pledgeId === f.lena)!);
      const waiting = m.accrued + m.capturePending;
      expect({
        status: m.status,
        authorized: m.authorized,
        captured: m.captured,
        waiting,
        rest: m.authorized - m.captured - waiting - m.released - m.uncollected - m.reversed,
        released: m.released,
      }).toEqual(want);
      expect(m.pledgeId).toBe(f.lena);
      // the others are untouched: mergeChain of a one-hold chain is that hold
      for (const c of chains.filter((x) => x.root.pledgeId !== f.lena)) expect(mergeChain(c)).toBe(c.root);
      if (stage === "race") expect(f.view.holds.find((h) => h.pledgeId === f.renewal)).toMatchObject({ authorized: 2000, usable: 1667, surplus: 333 });
    });
  }
});

describe("the fixture for screens: a drive with one renewed donor (made by the real service)", () => {
  it("has two holds for Lena, linked both ways, and groups them into one donor whose pledge is the first hold", async () => {
    const f = await renewedDrive();
    const old = f.view.holds.find((h) => h.pledgeId === f.lena)!;
    const nw = f.view.holds.find((h) => h.pledgeId === f.renewal)!;
    expect(old).toMatchObject({ status: "voided", renewedTo: f.renewal, authorized: 2000 });
    expect(nw).toMatchObject({ status: "authorized", renews: f.lena, currency: "EUR" });
    expect(old.captured + nw.authorized).toBe(2000); // what Lena pledged, counted once
    const chains = groupByChain(f.view.holds);
    expect(chains).toHaveLength(f.view.holds.length - 1); // Lena once; every other hold alone
    const lena = chains.find((c) => c.root.pledgeId === f.lena)!;
    expect(lena.members.map((m) => m.pledgeId)).toEqual([f.lena, f.renewal]);
    expect(lena.latest.pledgeId).toBe(f.renewal);
    expect(lena.root.authorized).toBe(2000);
  });
});

describe("renewal chains on screens", () => {
  const holds = [
    { pledgeId: "lena", renewedTo: "lena.r2" },
    { pledgeId: "mark" },
    { pledgeId: "lena.r1", renews: "lena" }, // declined: never linked
    { pledgeId: "lena.r2", renews: "lena", renewedTo: "lena.r2.r1" },
    { pledgeId: "lena.r2.r1", renews: "lena.r2" },
    { pledgeId: "yuki.r1", renews: "yuki" }, // its first hold is not in the list: it stands alone
  ];

  it("finds the first hold of a chain", () => {
    expect(chainRootId(holds, "lena.r2.r1")).toBe("lena");
    expect(chainRootId(holds, "lena.r1")).toBe("lena");
    expect(chainRootId(holds, "mark")).toBe("mark");
    expect(chainRootId(holds, "yuki.r1")).toBe("yuki.r1");
  });

  it("groups one donor's holds into one entry, linked holds first to latest, a declined renewal last", () => {
    const g = groupByChain(holds);
    expect(g.map((c) => c.root.pledgeId)).toEqual(["lena", "mark", "yuki.r1"]);
    const lena = g[0];
    expect(lena.members.map((m) => m.pledgeId)).toEqual(["lena", "lena.r2", "lena.r2.r1", "lena.r1"]);
    expect(lena.latest.pledgeId).toBe("lena.r2.r1");
    expect(g[1]).toMatchObject({ members: [{ pledgeId: "mark" }], latest: { pledgeId: "mark" } });
  });

  it("leaves a list without renewals as it was: one entry per hold, same order", () => {
    const plain = [{ pledgeId: "a" }, { pledgeId: "b" }, { pledgeId: "c" }];
    expect(groupByChain(plain).map((c) => [c.root.pledgeId, c.members.length])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
  });
});
