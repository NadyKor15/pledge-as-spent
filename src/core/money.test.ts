import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  currencyExponent,
  divRound,
  formatAmount,
  minorRate,
  money,
  parseAmount,
  parseRate,
  toBase,
  toQuote,
  validateFx,
} from "./money";
import { CoreError } from "./errors";
import type { CurrencyCode, FxRate } from "./types";
import { arbFx, CURRENCIES, RUNS } from "./testing/arbitraries";

const fx = (base: CurrencyCode, quote: CurrencyCode, rate: string): FxRate => ({
  base,
  quote,
  rate,
  source: "test",
  asOf: "2026-10-23",
});

describe("currency exponents", () => {
  it("JPY, HUF and TWD have no minor unit; the rest have two", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("HUF")).toBe(0);
    expect(currencyExponent("TWD")).toBe(0);
    for (const c of ["USD", "EUR", "GBP", "CAD", "AUD"]) expect(currencyExponent(c)).toBe(2);
  });

  it("rejects codes that are not three upper-case letters", () => {
    expect(() => currencyExponent("jpy")).toThrow(CoreError);
    expect(() => currencyExponent("EURO")).toThrow(/invalid_currency/);
  });
});

describe("formatAmount", () => {
  it("formats for PayPal", () => {
    expect(formatAmount({ currency: "JPY", minor: 3000 })).toBe("3000");
    expect(formatAmount({ currency: "EUR", minor: 2000 })).toBe("20.00");
    expect(formatAmount({ currency: "USD", minor: 5 })).toBe("0.05");
    expect(formatAmount({ currency: "USD", minor: 0 })).toBe("0.00");
    expect(formatAmount({ currency: "EUR", minor: -105 })).toBe("-1.05");
    expect(formatAmount({ currency: "HUF", minor: 149 })).toBe("149");
  });

  it("refuses fractional minor units (fractional yen)", () => {
    expect(() => formatAmount({ currency: "JPY", minor: 3000.5 })).toThrow(/invalid_amount/);
    expect(() => money("JPY", 0.1)).toThrow(CoreError);
  });
});

describe("parseAmount", () => {
  it("parses PayPal values back to minor units", () => {
    expect(parseAmount("JPY", "3000")).toBe(3000);
    expect(parseAmount("EUR", "20.00")).toBe(2000);
    expect(parseAmount("EUR", "20")).toBe(2000);
    expect(parseAmount("EUR", "20.5")).toBe(2050);
    expect(parseAmount("USD", ".5")).toBe(50);
    expect(parseAmount("USD", "-1.05")).toBe(-105);
    expect(Object.is(parseAmount("USD", "-0.00"), 0)).toBe(true);
  });

  it("treats a fractional yen as an error", () => {
    expect(() => parseAmount("JPY", "3000.5")).toThrow(/JPY takes 0 decimal places/);
    expect(() => parseAmount("JPY", "3000.00")).toThrow(/invalid_amount/);
    expect(() => parseAmount("EUR", "20.001")).toThrow(/invalid_amount/);
  });

  it("rejects non-numbers", () => {
    for (const v of ["", "-", ".", "abc", "1,50", "1e3", " 1"]) {
      expect(() => parseAmount("USD", v), v).toThrow(CoreError);
    }
  });
});

describe("rates", () => {
  it("parses decimal strings exactly", () => {
    expect(parseRate("162.35")).toEqual({ num: 16235n, den: 100n });
    expect(parseRate("1")).toEqual({ num: 1n, den: 1n });
    expect(parseRate("0.00616")).toEqual({ num: 616n, den: 100000n });
  });

  it("rejects zero, negatives and non-decimal notation", () => {
    for (const r of ["0", "0.000", "-1", "1e3", "", "1.", ".5", "1,5"]) {
      expect(() => parseRate(r), r).toThrow(/invalid_rate/);
    }
  });

  it("requires a rate of exactly 1 between a currency and itself", () => {
    expect(() => validateFx(fx("JPY", "JPY", "1.000"))).not.toThrow();
    expect(() => validateFx(fx("JPY", "JPY", "1.5"))).toThrow(/invalid_rate/);
  });

  it("knows how many base minor units one quote minor unit is worth", () => {
    // 1 EUR cent = 1.6235 yen
    expect(minorRate(fx("JPY", "EUR", "162.35"))).toEqual({ num: 16235n, den: 10000n });
  });
});

describe("toBase / toQuote rounding", () => {
  const eurJpy = fx("JPY", "EUR", "162.35");
  const eurUsd = fx("USD", "EUR", "1.5");
  const jpyEur = fx("EUR", "JPY", "0.00616");
  const usdPerEur2 = fx("USD", "EUR", "2");

  it("converts exact amounts without rounding", () => {
    expect(toBase(2000, eurJpy)).toBe(3247);
    expect(toQuote(3247, eurJpy)).toBe(2000);
    expect(toBase(300000, jpyEur)).toBe(184800);
    expect(toBase(0, eurJpy)).toBe(0);
  });

  it("rounds half-up by default, floor and ceil on request", () => {
    // 1 cent = 1.6235 yen
    expect([toBase(1, eurJpy), toBase(1, eurJpy, "floor"), toBase(1, eurJpy, "ceil")]).toEqual([2, 1, 2]);
    // 2 cents = 3.247 yen
    expect([toBase(2, eurJpy), toBase(2, eurJpy, "floor"), toBase(2, eurJpy, "ceil")]).toEqual([3, 3, 4]);
    // 648 yen = 399.137... cents
    expect([toQuote(648, eurJpy), toQuote(648, eurJpy, "floor"), toQuote(648, eurJpy, "ceil")]).toEqual([
      399, 399, 400,
    ]);
    // 1 yen = 0.616 euro cents
    expect([toBase(1, jpyEur), toBase(1, jpyEur, "floor"), toBase(1, jpyEur, "ceil")]).toEqual([1, 0, 1]);
  });

  it("rounds an exact half away from zero", () => {
    expect([toBase(1, eurUsd), toBase(1, eurUsd, "floor"), toBase(1, eurUsd, "ceil")]).toEqual([2, 1, 2]);
    expect([toBase(3, eurUsd), toBase(3, eurUsd, "floor"), toBase(3, eurUsd, "ceil")]).toEqual([5, 4, 5]);
    expect([toQuote(1, usdPerEur2), toQuote(1, usdPerEur2, "floor"), toQuote(1, usdPerEur2, "ceil")]).toEqual([
      1, 0, 1,
    ]);
    expect([toBase(-3, eurUsd), toBase(-3, eurUsd, "floor"), toBase(-3, eurUsd, "ceil")]).toEqual([-5, -5, -4]);
  });

  it("rejects non-integer input and results outside the safe range", () => {
    expect(() => toBase(1.5, eurJpy)).toThrow(/invalid_amount/);
    expect(() => toQuote(Number.MAX_SAFE_INTEGER, jpyEur)).toThrow(/out of safe integer range/);
    expect(() => divRound(1n, 0n, "floor")).toThrow(CoreError);
  });
});

describe("money properties", () => {
  it("format/parse round-trips every currency", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES, "HUF", "TWD"),
        fc.integer({ min: -1e12, max: 1e12 }),
        (currency, minor) => {
          expect(parseAmount(currency, formatAmount({ currency, minor }))).toBe(minor);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("floor <= exact <= ceil, ceil - floor <= 1, half-up within half a unit", () => {
    fc.assert(
      fc.property(arbFx(), fc.integer({ min: 0, max: 1e9 }), (rate, q) => {
        const k = minorRate(rate);
        const exactNum = BigInt(q) * k.num; // exact base = exactNum / k.den
        const lo = BigInt(toBase(q, rate, "floor"));
        const hi = BigInt(toBase(q, rate, "ceil"));
        const hu = BigInt(toBase(q, rate, "half-up"));
        expect(lo * k.den <= exactNum && exactNum < (lo + 1n) * k.den).toBe(true);
        expect(hi * k.den >= exactNum && exactNum > (hi - 1n) * k.den).toBe(true);
        expect(hi - lo <= 1n).toBe(true);
        const diff = hu * k.den - exactNum;
        expect(2n * (diff < 0n ? -diff : diff) <= k.den).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("the floor capacity of a hold always converts back within the hold", () => {
    fc.assert(
      fc.property(arbFx(), fc.integer({ min: 0, max: 1e9 }), (rate, available) => {
        const cap = toBase(available, rate, "floor");
        expect(toQuote(cap, rate, "half-up")).toBeLessThanOrEqual(available);
      }),
      { numRuns: RUNS },
    );
  });

  it("conversion is monotone", () => {
    fc.assert(
      fc.property(arbFx(), fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 1e9 }), (rate, a, b) => {
        const [x, y] = a <= b ? [a, b] : [b, a];
        expect(toBase(x, rate)).toBeLessThanOrEqual(toBase(y, rate));
        expect(toQuote(x, rate)).toBeLessThanOrEqual(toQuote(y, rate));
      }),
      { numRuns: RUNS },
    );
  });
});
