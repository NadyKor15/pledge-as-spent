import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateTax, isTaxOnTop, reconcile } from "../../src/receipts/checks";
import { line, receipt } from "./fixtures";

describe("reconcile", () => {
  it("accepts tax-inclusive lines that add up to the total", () => {
    expect(reconcile(receipt()).ok).toBe(true);
  });

  it("rejects an inclusive receipt that is off by one", () => {
    const r = reconcile(receipt({ totalMinor: 1501 }));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/add up to ¥1,500 but the printed total is ¥1,501/);
  });

  it("nets discount lines", () => {
    const r = receipt({ lines: [line(1, 1000), line(2, -150), line(3, 500)], totalMinor: 1350 });
    expect(reconcile(r).ok).toBe(true);
  });

  it("adds tax on top and tolerates one minor unit per tax line", () => {
    const base = { taxIncluded: false, taxMinor: 120 };
    expect(reconcile(receipt({ ...base, totalMinor: 1620 })).ok).toBe(true);
    expect(reconcile(receipt({ ...base, totalMinor: 1621 })).ok).toBe(true);
    expect(reconcile(receipt({ ...base, totalMinor: 1619 })).ok).toBe(true);
    expect(reconcile(receipt({ ...base, totalMinor: 1622 })).ok).toBe(false);
  });

  it("allows one unit per distinct tax rate", () => {
    const lines = [line(1, 1000, 800), line(2, 500, 1000)];
    const base = { lines, taxIncluded: false, taxMinor: 130 };
    expect(reconcile(receipt({ ...base, totalMinor: 1632 })).ok).toBe(true);
    expect(reconcile(receipt({ ...base, totalMinor: 1633 })).ok).toBe(false);
  });

  it("reviews a receipt whose added tax was not read", () => {
    const r = reconcile(receipt({ taxIncluded: false, taxMinor: null }));
    expect(r.ok).toBe(false);
    expect(r.expectedTotalMinor).toBeNull();
    expect(r.reasons[0]).toMatch(/tax amount was not read/);
  });

  it("picks the closer reading when it is not printed which way tax goes", () => {
    const a = receipt({ taxIncluded: null, taxMinor: 120, totalMinor: 1500 });
    expect(isTaxOnTop(a)).toBe(false);
    expect(reconcile(a).ok).toBe(true);
    const b = receipt({ taxIncluded: null, taxMinor: 120, totalMinor: 1620 });
    expect(isTaxOnTop(b)).toBe(true);
    expect(reconcile(b).ok).toBe(true);
  });

  it("checks the printed subtotal against the lines", () => {
    expect(reconcile(receipt({ subtotalMinor: 1500 })).ok).toBe(true);
    expect(reconcile(receipt({ subtotalMinor: 1400 })).reasons.join()).toMatch(/subtotal is ¥1,400/);
  });

  it("flags a receipt with no lines", () => {
    expect(reconcile(receipt({ lines: [], totalMinor: 0 })).reasons.join()).toMatch(/no lines/);
  });

  it("property: consistent totals pass, totals past the tolerance fail", () => {
    const amounts = fc.array(fc.integer({ min: -2000, max: 20000 }), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(amounts, fc.integer({ min: 0, max: 5000 }), fc.boolean(), fc.integer({ min: 1, max: 40 }), (amts, tax, onTop, off) => {
        const lines = amts.map((a, i) => line(i + 1, a, onTop ? 1000 : null));
        const sum = amts.reduce((s, a) => s + a, 0);
        const base = onTop ? { taxIncluded: false, taxMinor: tax } : { taxIncluded: true, taxMinor: null };
        const expected = onTop ? sum + tax : sum;
        const tol = onTop ? 1 : 0;
        expect(reconcile(receipt({ ...base, lines, totalMinor: expected })).ok).toBe(true);
        expect(reconcile(receipt({ ...base, lines, totalMinor: expected + tol })).ok).toBe(true);
        expect(reconcile(receipt({ ...base, lines, totalMinor: expected - tol })).ok).toBe(true);
        // A total that equals the lines exactly reads as "tax inside" (the arithmetic outranks the label): not a mismatch.
        if (expected + tol + off !== sum) expect(reconcile(receipt({ ...base, lines, totalMinor: expected + tol + off })).ok).toBe(false);
        if (expected - tol - off !== sum) expect(reconcile(receipt({ ...base, lines, totalMinor: expected - tol - off })).ok).toBe(false);
      }),
    );
  });
});

describe("allocateTax", () => {
  const onTop = (lines: ReturnType<typeof line>[], taxMinor: number) =>
    receipt({ lines, taxIncluded: false, taxMinor, totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0) + taxMinor });

  it("gives zeros when tax is already inside the prices", () => {
    expect(allocateTax(receipt())).toEqual([0, 0]);
  });

  it("splits by amount when no line carries a rate", () => {
    expect(allocateTax(onTop([line(1, 3000), line(2, 1000)], 400))).toEqual([300, 100]);
  });

  it("gives the leftover unit to the largest remainder, first line on a tie", () => {
    expect(allocateTax(onTop([line(1, 100), line(2, 100), line(3, 100)], 1))).toEqual([1, 0, 0]);
    expect(allocateTax(onTop([line(1, 100), line(2, 100), line(3, 100)], 2))).toEqual([1, 1, 0]);
    // 10 x (1, 2) / 3 = 3.33 and 6.67: the second line has the bigger remainder.
    expect(allocateTax(onTop([line(1, 1), line(2, 2)], 10))).toEqual([3, 7]);
  });

  it("weights by the line rate and leaves rate-less lines untaxed", () => {
    const shares = allocateTax(onTop([line(1, 1000, 800), line(2, 1000, 1000), line(3, 3000, null)], 180));
    expect(shares).toEqual([80, 100, 0]);
  });

  it("nets a discount through its own share", () => {
    const shares = allocateTax(onTop([line(1, 1000, 1000), line(2, -200, 1000)], 80))!;
    expect(shares).toEqual([100, -20]);
  });

  it("returns null when the weights give nothing to split", () => {
    expect(allocateTax(onTop([line(1, 0), line(2, 0)], 50))).toBeNull();
  });

  it("property: shares always add up to the tax", () => {
    const l = fc.record({ a: fc.integer({ min: 1, max: 100000 }), r: fc.constantFrom(null, 800, 1000) });
    fc.assert(
      fc.property(fc.array(l, { minLength: 1, maxLength: 15 }), fc.integer({ min: 1, max: 100000 }), (ls, tax) => {
        const lines = ls.map((x, i) => line(i + 1, x.a, x.r));
        const shares = allocateTax(onTop(lines, tax))!;
        expect(shares).not.toBeNull();
        expect(shares.reduce((s, x) => s + x, 0)).toBe(tax);
        expect(shares.every((s) => s >= 0)).toBe(true);
      }),
    );
  });
});

describe("tax flag that contradicts the arithmetic (hero total_mismatch)", () => {
  // The reader said "tax added on top" with tax 923, but the lines already add up to the printed total:
  // 14,646 + 923 = 15,569 was compared with 14,646 and the receipt was held for review.
  const lines = [line(1, 798, 800), line(2, 472, 800), line(3, 2596, 1000), line(4, 10780, 1000)];
  const sum = 14646;

  it("treats the tax as inside when the lines already equal the total", () => {
    const r = receipt({ lines, taxIncluded: false, taxMinor: 923, totalMinor: sum });
    expect(r.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(sum);
    expect(isTaxOnTop(r)).toBe(false);
    expect(reconcile(r)).toMatchObject({ ok: true, expectedTotalMinor: sum, deltaMinor: 0 });
    expect(allocateTax(r)).toEqual([0, 0, 0, 0]);
  });

  it("treats the tax as on top when it is said to be inside but lines plus tax equal the total", () => {
    const r = receipt({ lines, taxIncluded: true, taxMinor: 923, totalMinor: sum + 923 });
    expect(isTaxOnTop(r)).toBe(true);
    expect(reconcile(r).ok).toBe(true);
  });

  it("keeps what is said when neither reading fits, so a wrong total is still caught", () => {
    expect(reconcile(receipt({ lines, taxIncluded: false, taxMinor: 923, totalMinor: sum + 5 })).ok).toBe(false);
    expect(reconcile(receipt({ lines, taxIncluded: true, taxMinor: 923, totalMinor: sum + 5 })).ok).toBe(false);
  });

  it("leaves a correct flag alone", () => {
    expect(isTaxOnTop(receipt({ lines, taxIncluded: false, taxMinor: 923, totalMinor: sum + 923 }))).toBe(true);
    expect(isTaxOnTop(receipt({ lines, taxIncluded: true, taxMinor: 923, totalMinor: sum }))).toBe(false);
  });
});
