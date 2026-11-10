import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chainIds, holdById, shareGroups, shownHolds, shownId } from "@/ui/derive";
import { chainFee } from "@/ui/fee-line";
import { routeQuestion } from "@/agent/route";
import { donorFigures, findHolds } from "@/agent/tools";
import { meterParts, METER_KEYS } from "@/ui/hold-meter";
import { deriveLedger } from "@/ui/ledger/derive";
import { needMeter } from "@/ui/ledger/need-meter";
import { groupByChain, mergeChain } from "@/ui/renewal-chain";
import type { DriveView, Hold } from "@/ui/types";

// The book counts a renewed donor once (RENEW, P3FL): after a renewal Lena has two holds, the old one voided with
// `renewedTo`, the new one with `renews`. Numbers follow P3FL's four stages (tests/app/support/renewal-fixture.ts in
// p3fl3), built here on the recorded open drive: Lena pledged €20.00 and her three water lines cost €4.58.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const OLD = "demo-4e8aa74db5.water";
const NEW = "demo-4e8aa74db5.water.r1";

type Stage = "renewed" | "captured" | "closed" | "race";

function renewed(stage: Stage): DriveView {
  const v = fixture("open");
  const old = v.holds.find((h) => h.pledgeId === OLD)!;
  const spent = old.accrued; // 458: her three lines, captured from the old hold before it was voided
  const carry = old.authorized - spent; // 1542
  const second = stage === "renewed" || stage === "race" ? 0 : 100; // a further line, captured from the new hold
  const oldHold = { ...old, captured: spent, accrued: 0, released: carry, status: "voided", renewedTo: NEW } as Hold;
  const newHold = {
    ...old,
    pledgeId: NEW,
    pledged: stage === "race" ? 2000 : carry,
    authorized: stage === "race" ? 2000 : carry,
    usable: carry,
    ...(stage === "race" ? { surplus: 2000 - carry } : {}),
    renews: OLD,
    accrued: 0,
    captured: second,
    released: stage === "closed" ? carry - second : 0,
    status: stage === "closed" ? "voided" : second > 0 ? "partially_captured" : "authorized",
  } as Hold;
  v.holds = v.holds.flatMap((h) => (h.pledgeId === OLD ? [oldHold, newHold] : [h]));
  v.ledger = v.ledger.map((r) => (r.pledgeId === OLD ? { ...r, status: "captured" } : r)) as DriveView["ledger"];
  if (second > 0) {
    const like = v.ledger.find((r) => r.pledgeId === OLD)!;
    v.ledger = [...v.ledger, { ...like, rowId: `${like.rowId}.r1`, pledgeId: NEW, amount: second, base: Math.round((like.base * second) / (like.amount ?? 1)), status: "captured" }];
  }
  if (stage === "closed") v.drive = { ...v.drive, status: "closed" };
  return v;
}

const sumParts = (p: ReturnType<typeof meterParts>) => METER_KEYS.reduce((a, k) => a + p[k], 0);

describe("no renewal: the book is as before", () => {
  for (const name of ["open", "closed"]) {
    it(`${name}: every chain is one hold, merged into itself; each donor's meter is meterParts of their hold`, () => {
      const v = fixture(name);
      for (const c of groupByChain(v.holds)) {
        expect(c.members).toHaveLength(1);
        expect(mergeChain(c)).toBe(c.root);
      }
      const m = deriveLedger(v);
      expect(m.donors.map((d) => d.pledgeId)).toEqual(v.holds.filter((h) => h.kind === "donor" && h.authorized > 0).map((h) => h.pledgeId));
      for (const d of m.donors) expect(d.meter).toEqual(meterParts(holdById(v, d.pledgeId)!));
    });
  }
});

describe("a donor with a renewal is counted once", () => {
  const expected: Record<Stage, { charged: number; waiting: number; held: number; never: number; back: number }> = {
    renewed: { charged: 458, waiting: 0, held: 1542, never: 0, back: 0 },
    captured: { charged: 558, waiting: 0, held: 1442, never: 0, back: 0 },
    closed: { charged: 558, waiting: 0, held: 0, never: 1442, back: 0 },
    race: { charged: 458, waiting: 0, held: 1542, never: 0, back: 0 },
  };
  for (const stage of Object.keys(expected) as Stage[]) {
    it(`${stage}: one row for Lena, her pledge at most €20.00, the parts as the core counts them`, () => {
      const v = renewed(stage);
      expect(groupByChain(v.holds)).toHaveLength(v.holds.length - 1);
      const m = deriveLedger(v);
      const lena = m.donors.filter((d) => d.name.startsWith("Lena"));
      expect(lena).toHaveLength(1);
      expect(m.donors).toHaveLength(3);
      const d = lena[0];
      expect(d.pledgeId).toBe(OLD);
      const p = d.meter!;
      expect(p.total).toBe(2000);
      expect(sumParts(p)).toBe(p.total);
      expect(p.total).toBeLessThanOrEqual(holdById(v, OLD)!.authorized);
      expect({ charged: p.charged, waiting: p.waiting, held: p.held, never: p.never, back: p.back }).toEqual(expected[stage]);
      // the surplus of the race is neither held nor never charged: the donor never promised it
      expect(p.held + p.never).toBe(2000 - p.charged);
      // spent in the drive's currency never exceeds what she pledged
      expect(d.spentBase).toBeLessThanOrEqual(d.pledgedBase);
      // the need and the book's rows point at her one row
      expect(m.needs.find((n) => n.needId === "water")!.pledgeIds).toEqual([OLD]);
      expect(m.book.filter((r) => r.kind === "donor_share" && r.payerLabel.startsWith("Lena")).every((r) => r.pledgeId === OLD)).toBe(true);
      // the water bar has one donor's rest, not two
      const w = needMeter(v, "water", m);
      expect(w.promisedBy.filter((x) => x.startsWith("Lena")).length).toBeLessThanOrEqual(1);
      const restBase = d.heldBase + d.backBase;
      expect(w.promised + w.returning + w.never + w.back).toBe(restBase);
    });
  }
});

describe("the coordinator's and the donors' screens: Lena is one card", () => {
  it("no renewal: shownHolds is the drive's holds, the very same objects", () => {
    for (const name of ["open", "closed"]) {
      const v = fixture(name);
      const shown = shownHolds(v);
      expect(shown).toHaveLength(v.holds.length);
      shown.forEach((h, i) => expect(h).toBe(v.holds[i]));
      for (const h of v.holds) {
        expect(shownId(v, h.pledgeId)).toBe(h.pledgeId);
        expect(chainIds(v, h.pledgeId)).toEqual([h.pledgeId]);
      }
    }
  });
  for (const stage of ["renewed", "captured", "closed", "race"] as Stage[]) {
    it(`${stage}: one donor hold for Lena at her first hold's id and amount; her shares grouped once per need`, () => {
      const v = renewed(stage);
      const donors = shownHolds(v).filter((h) => h.kind === "donor");
      expect(donors).toHaveLength(3);
      const lena = donors.filter((h) => h.donorName.startsWith("Lena"));
      expect(lena).toHaveLength(1);
      expect(lena[0].pledgeId).toBe(OLD);
      expect(lena[0].authorized).toBe(2000);
      expect(meterParts(lena[0]).total).toBe(2000);
      expect(chainIds(v, OLD)).toEqual([OLD, NEW]);
      expect(shownId(v, NEW)).toBe(OLD);
      for (const g of shareGroups(v)) {
        const ids = g.donors.map((d) => d.pledgeId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).not.toContain(NEW);
      }
    });
  }
  it("PayPal's fee on Lena's share adds her chain's holds; one hold keeps its own entry", () => {
    const fees = {
      [OLD]: { currency: "EUR", minor: 51, captures: 1, reported: 1 },
      [NEW]: { currency: "EUR", minor: 35, captures: 1, reported: 0 },
    };
    expect(chainFee(fees, [OLD, NEW])).toEqual({ currency: "EUR", minor: 86, captures: 2, reported: 1 });
    expect(chainFee(fees, [OLD])).toBe(fees[OLD]);
    expect(chainFee(null, [OLD])).toBeUndefined();
  });
});

describe("the agent ('Ask the book') reads Lena once", () => {
  for (const stage of ["renewed", "captured", "closed", "race"] as Stage[]) {
    it(`${stage}: one hit for her name, her figures over the chain at €20.00, the question routed to her`, () => {
      const v = renewed(stage);
      const hits = findHolds(v, "Lena");
      expect(hits).toHaveLength(1);
      expect(hits[0].pledgeId).toBe(OLD);
      const f = donorFigures(v, hits[0]);
      expect(f.pledged).toBe(2000);
      expect(f.spent + f.back + f.held).toBe(2000);
      const book = deriveLedger(v).donors.find((d) => d.pledgeId === OLD)!;
      expect({ spent: f.spent, held: f.held, back: f.back }).toEqual({ spent: book.spent, held: book.held, back: book.back });
      // every donor share of hers, from either hold, is in her figures
      expect(f.rows.filter((r) => r.kind === "donor_share")).toHaveLength(v.ledger.filter((r) => r.pledgeId === OLD || r.pledgeId === NEW).length);
      expect(routeQuestion(v, "How much of Lena's money was spent?")?.donor).toBe(holdById(v, OLD)!.donorName);
    });
  }
  it("no renewal: the same hit and the same route as on the plain drive", () => {
    const v = fixture("closed");
    const lena = v.holds.filter((h) => h.donorName.startsWith("Lena"));
    expect(lena).toHaveLength(1);
    expect(findHolds(v, "Lena")[0]).toBe(lena[0]);
    expect(routeQuestion(v, "How much of Lena's money was spent?")?.donor).toBe(lena[0].donorName);
  });
});
