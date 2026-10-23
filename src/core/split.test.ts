import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { largestRemainder } from "./split";
import { CoreError } from "./errors";
import { RUNS } from "./testing/arbitraries";

const amounts = (total: number, weights: Record<string, number>) =>
  Object.fromEntries(
    largestRemainder(
      total,
      Object.entries(weights).map(([id, weight]) => ({ id, weight })),
    ).map((p) => [p.id, p.amount]),
  );

describe("largestRemainder", () => {
  it("gives leftover units to the largest remainders", () => {
    expect(amounts(10, { a: 1, b: 2, c: 7 })).toEqual({ a: 1, b: 2, c: 7 });
    expect(amounts(100, { a: 1, b: 1, c: 1 })).toEqual({ a: 34, b: 33, c: 33 });
    // 7 * 3/10 = 2.1, 7 * 7/10 = 4.9 -> the 0.9 remainder wins
    expect(amounts(7, { x: 3, y: 7 })).toEqual({ x: 2, y: 5 });
  });

  it("breaks ties by id ascending, whatever the input order", () => {
    expect(amounts(100, { c: 1, b: 1, a: 1 })).toEqual({ a: 34, b: 33, c: 33 });
    expect(amounts(2, { p3: 1, p1: 1, p2: 1 })).toEqual({ p1: 1, p2: 1, p3: 0 });
  });

  it("returns portions in input order and zero for zero weights", () => {
    const out = largestRemainder(5, [
      { id: "z", weight: 0 },
      { id: "y", weight: 3 },
    ]);
    expect(out).toEqual([
      { id: "z", amount: 0 },
      { id: "y", amount: 5 },
    ]);
    expect(amounts(0, { a: 0, b: 0 })).toEqual({ a: 0, b: 0 });
  });

  it("rejects impossible splits", () => {
    expect(() => amounts(1, { a: 0 })).toThrow(/zero total weight/);
    expect(() => amounts(-1, { a: 1 })).toThrow(CoreError);
    expect(() => amounts(1.5, { a: 1 })).toThrow(CoreError);
    expect(() => amounts(1, { a: -1 })).toThrow(CoreError);
    expect(() =>
      largestRemainder(1, [
        { id: "a", weight: 1 },
        { id: "a", weight: 1 },
      ]),
    ).toThrow(/duplicate id/);
  });
});

const arbParts = fc.uniqueArray(
  fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), weight: fc.integer({ min: 0, max: 1e9 }) }),
  { minLength: 1, maxLength: 30, selector: (p) => p.id },
);

describe("largestRemainder properties", () => {
  it("portions sum to the total exactly and stay within one unit of the exact share", () => {
    fc.assert(
      fc.property(arbParts, fc.integer({ min: 0, max: 1e12 }), (parts, total) => {
        const W = parts.reduce((a, p) => a + BigInt(p.weight), 0n);
        fc.pre(W > 0n || total === 0);
        const out = largestRemainder(total, parts);
        expect(out.reduce((a, p) => a + p.amount, 0)).toBe(total);
        out.forEach((p, i) => {
          if (W === 0n) return;
          const exact = BigInt(total) * BigInt(parts[i].weight);
          const got = BigInt(p.amount) * W;
          expect(got >= exact - W && got <= exact + W).toBe(true);
          if (parts[i].weight === 0) expect(p.amount).toBe(0);
        });
      }),
      { numRuns: RUNS },
    );
  });

  it("never gives a part more than its weight when the total fits", () => {
    fc.assert(
      fc.property(arbParts, fc.double({ min: 0, max: 1, noNaN: true }), (parts, f) => {
        const W = parts.reduce((a, p) => a + p.weight, 0);
        fc.pre(W > 0);
        const total = Math.floor(W * f);
        largestRemainder(total, parts).forEach((p, i) => expect(p.amount).toBeLessThanOrEqual(parts[i].weight));
      }),
      { numRuns: RUNS },
    );
  });

  it("does not depend on input order", () => {
    fc.assert(
      fc.property(arbParts, fc.integer({ min: 0, max: 1e9 }), fc.nat(), (parts, total, seed) => {
        fc.pre(parts.some((p) => p.weight > 0));
        const shuffled = [...parts].sort((a, b) => ((a.id.charCodeAt(0) * 31 + seed) % 7) - ((b.id.charCodeAt(0) * 31 + seed) % 7));
        const byId = (xs: { id: string; amount: number }[]) => Object.fromEntries(xs.map((x) => [x.id, x.amount]));
        expect(byId(largestRemainder(total, shuffled))).toEqual(byId(largestRemainder(total, parts)));
      }),
      { numRuns: RUNS },
    );
  });
});
