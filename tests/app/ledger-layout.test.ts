import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLedger, type LedgerDonor } from "@/ui/ledger/derive";
import { locate } from "@/ui/ledger/geo";
import land from "@/ui/ledger/land.json";
import { landPath, MAX_ARCS, planMap, type Box, type MapPlan } from "@/ui/ledger/layout";
import { focusOf, linesOf, LedgerStore } from "@/ui/ledger/store";
import type { DriveView } from "@/ui/types";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;

const SIZES = [
  { width: 960, height: 540, compact: false },
  { width: 700, height: 460, compact: false },
  { width: 390, height: 220, compact: true },
];

const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function boxes(plan: MapPlan): Box[] {
  return plan.placed.flatMap((p) => [p.label, ...p.pills.map((x) => x.box)]);
}

function expectNoOverlap(plan: MapPlan) {
  const all = boxes(plan);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(hit(all[i], all[j]), `${JSON.stringify(all[i])} ${JSON.stringify(all[j])}`).toBe(false);
}

function expectInside(plan: MapPlan, width: number, height: number) {
  for (const b of boxes(plan)) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(width);
    expect(b.y + b.h).toBeLessThanOrEqual(height);
  }
}

function donor(i: number, city: string, country: string, spentBase: number, restBase: number): LedgerDonor {
  return {
    pledgeId: `p${i}`,
    name: `Donor${i}`,
    city,
    label: `Donor${i} · ${city}`,
    at: locate(city, country),
    currency: "USD",
    spent: spentBase,
    back: restBase,
    held: 0,
    spentText: `$${spentBase}.00`,
    restText: `$${restBase}.00`,
    restWord: "back",
    spentBase,
    restBase,
    needIds: [],
    lineKeys: [],
  };
}

const EIGHT = [
  donor(1, "Berlin", "DE", 900, 300),
  donor(2, "Hamburg", "DE", 800, 200),
  donor(3, "Paris", "FR", 700, 300),
  donor(4, "New York", "US", 600, 100),
  donor(5, "Columbus", "US", 500, 400),
  donor(6, "Tokyo", "JP", 400, 300),
  donor(7, "Osaka", "JP", 300, 200),
  donor(8, "Sydney", "AU", 200, 100),
];

describe.each(SIZES)("the money map at $width px", (size) => {
  it.each(["closed", "open"])("keeps every label of the %s drive apart and inside", (name) => {
    const plan = planMap(deriveLedger(fixture(name)).donors, size);
    expect(plan.placed).toHaveLength(3);
    expect(plan.listed).toEqual([]);
    expectNoOverlap(plan);
    expectInside(plan, size.width, size.height);
  });

  it("eight donors: nothing overlaps, and nobody disappears", () => {
    const plan = planMap(EIGHT, size);
    expect(plan.placed.length).toBeLessThanOrEqual(MAX_ARCS);
    expectNoOverlap(plan);
    expectInside(plan, size.width, size.height);
    const shown = new Set([...plan.placed.map((p) => p.donor.pledgeId), ...plan.listed.map((d) => d.pledgeId)]);
    expect(shown.size).toBe(8);
  });

  it("two donors in one city get two dots", () => {
    const plan = planMap([donor(1, "Berlin", "DE", 900, 300), donor(2, "Berlin", "DE", 800, 200)], size);
    const [a, b] = plan.placed;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8);
    expectNoOverlap(plan);
  });

  it("a donor with no coordinates has no arc and stays in the list", () => {
    const lost = { ...donor(9, "Nowhere", "XX", 100, 100), at: null };
    const plan = planMap([lost, ...EIGHT.slice(0, 2)], size);
    expect(plan.placed.map((p) => p.donor.pledgeId)).not.toContain("p9");
    expect(plan.listed.map((d) => d.pledgeId)).toEqual(["p9"]);
  });

  it("no donors at all", () => {
    expect(planMap([], size)).toMatchObject({ placed: [], listed: [] });
  });
});

describe("what the arcs say", () => {
  const size = SIZES[0];

  it("a closed drive sends money there and back, an arrowhead on the way back", () => {
    const plan = planMap(deriveLedger(fixture("closed")).donors, size);
    for (const p of plan.placed) {
      expect(p.arcs.map((a) => a.flow)).toEqual(["spent", "back"]);
      expect(p.arcs[1].head).not.toBeNull();
      expect(p.pills.map((x) => x.flow)).toEqual(["spent", "back"]);
    }
    expect(plan.placed.flatMap((p) => p.pills.map((x) => x.text))).toEqual(expect.arrayContaining(["$21.45", "$8.55 back", "€4.58", "€15.42 back", "¥1,237", "¥1,763 back"]));
  });

  it("every arc of the map ends at the same hub", () => {
    const plan = planMap(deriveLedger(fixture("closed")).donors, size);
    const hub = `${plan.hub.x.toFixed(1)} ${plan.hub.y.toFixed(1)}`;
    for (const p of plan.placed) {
      expect(p.arcs[0].d.endsWith(hub)).toBe(true);
      expect(p.arcs[1].d.startsWith(`M${hub}`)).toBe(true);
    }
  });

  it("an open drive draws no return arc and keeps the amount with the donor", () => {
    const plan = planMap(deriveLedger(fixture("open")).donors, size);
    for (const p of plan.placed) {
      expect(p.arcs.map((a) => a.flow)).toEqual(["spent"]);
      expect(p.pills.map((x) => x.flow)).toEqual(["spent", "held"]);
    }
    expect(plan.placed.flatMap((p) => p.pills.map((x) => x.text))).toEqual(expect.arrayContaining(["$8.55 held", "€15.42 held", "¥1,763 held"]));
  });

  it("more money, thicker arc", () => {
    const [big, small] = planMap([donor(1, "Berlin", "DE", 900, 0), donor(2, "New York", "US", 100, 0)], size).placed.sort((a, b) => b.arcs[0].width - a.arcs[0].width);
    expect(big.donor.pledgeId).toBe("p1");
    expect(big.arcs[0].width).toBeGreaterThan(small.arcs[0].width);
  });
});

describe("the land path", () => {
  it("is small enough to be a single element", () => {
    const { d } = landPath(land, 960, 540, 1);
    expect(d.length).toBeLessThan(40_000);
  });

  it("the JSON stays under its budget", () => {
    expect(JSON.stringify(land).length).toBeLessThan(60_000);
  });
});

describe("picking a donor or a need", () => {
  const model = deriveLedger(fixture("closed"));
  const water = model.needs[0];
  const lena = model.donors[0];

  it("a donor lights up what they paid for, a need lights up who paid", () => {
    const byDonor = focusOf(model, { kind: "donor", pledgeId: lena.pledgeId })!;
    expect([...byDonor.needs]).toEqual(["water"]);
    const byNeed = focusOf(model, { kind: "need", needId: "water" })!;
    expect([...byNeed.donors]).toEqual([lena.pledgeId]);
  });

  it("both ends of a pair select the same lines", () => {
    expect(linesOf(model, { kind: "donor", pledgeId: lena.pledgeId })).toEqual(water.lineKeys);
    expect(water.lineKeys).toHaveLength(3);
  });

  it("a second press clears, and the filter follows", () => {
    const store = new LedgerStore(model);
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    store.toggle({ kind: "need", needId: "water" });
    expect(store.get().selected).toEqual({ kind: "need", needId: "water" });
    store.toggle({ kind: "need", needId: "water" });
    expect(store.get().selected).toBeNull();
    expect(seen).toEqual([[], water.lineKeys, []]);
  });

  it("hovering lights up without filtering", () => {
    const store = new LedgerStore(model);
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    store.hover({ kind: "donor", pledgeId: lena.pledgeId });
    expect(store.get().hovered).not.toBeNull();
    expect(seen).toEqual([[]]);
  });

  it("the selection survives Studio mounting the filter later", () => {
    const store = new LedgerStore(model);
    store.toggle({ kind: "need", needId: "water" });
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    expect(seen).toEqual([water.lineKeys]);
  });
});
