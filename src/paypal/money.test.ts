import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromPayPalValue, parsePayPalMoney, toPayPalValue } from "./money";

describe("toPayPalValue", () => {
  it("formats two-decimal currencies", () => {
    expect(toPayPalValue({ currency: "EUR", minor: 2000 })).toBe("20.00");
    expect(toPayPalValue({ currency: "USD", minor: 1290 })).toBe("12.90");
    expect(toPayPalValue({ currency: "USD", minor: 5 })).toBe("0.05");
    expect(toPayPalValue({ currency: "GBP", minor: 0 })).toBe("0.00");
  });

  it("formats JPY without decimals", () => {
    expect(toPayPalValue({ currency: "JPY", minor: 3000 })).toBe("3000");
    expect(toPayPalValue({ currency: "JPY", minor: 50000 })).toBe("50000");
  });

  it("rejects fractional yen, fractional cents, negatives and unknown currencies", () => {
    expect(() => toPayPalValue({ currency: "JPY", minor: 1.5 })).toThrow(/whole number/);
    expect(() => toPayPalValue({ currency: "EUR", minor: 740.5 })).toThrow(/whole number/);
    expect(() => toPayPalValue({ currency: "USD", minor: Number.NaN })).toThrow();
    expect(() => toPayPalValue({ currency: "USD", minor: -1 })).toThrow(/negative/);
    expect(() => toPayPalValue({ currency: "XXX" as never, minor: 1 })).toThrow(/Unsupported/);
  });
});

describe("fromPayPalValue", () => {
  it("parses PayPal strings into minor units", () => {
    expect(fromPayPalValue("EUR", "20.00")).toEqual({ currency: "EUR", minor: 2000 });
    expect(fromPayPalValue("EUR", "7.4")).toEqual({ currency: "EUR", minor: 740 });
    expect(fromPayPalValue("USD", "12")).toEqual({ currency: "USD", minor: 1200 });
    expect(fromPayPalValue("JPY", "3000")).toEqual({ currency: "JPY", minor: 3000 });
    expect(fromPayPalValue("JPY", "3000.00")).toEqual({ currency: "JPY", minor: 3000 });
  });

  it("rejects values a currency cannot carry or that are malformed", () => {
    expect(() => fromPayPalValue("JPY", "3000.5")).toThrow(/decimals/);
    expect(() => fromPayPalValue("EUR", "1.234")).toThrow(/decimals/);
    for (const bad of ["", "abc", "1e3", "-1.00", "1,00", " 1.00"]) expect(() => fromPayPalValue("USD", bad)).toThrow();
    expect(() => fromPayPalValue("BRL", "1.00")).toThrow(/Unsupported/);
  });

  it("round-trips every amount in every supported currency", () => {
    const currency = fc.constantFrom("USD", "EUR", "JPY", "GBP", "CAD", "AUD" as const);
    fc.assert(
      fc.property(currency, fc.integer({ min: 0, max: 10_000_000_00 }), (c, minor) => {
        expect(fromPayPalValue(c, toPayPalValue({ currency: c, minor }))).toEqual({ currency: c, minor });
      }),
    );
  });
});

describe("parsePayPalMoney", () => {
  it("accepts both the Orders/Payments and the Payouts shapes", () => {
    expect(parsePayPalMoney({ currency_code: "USD", value: "7.44" })).toEqual({ currency: "USD", minor: 744 });
    expect(parsePayPalMoney({ currency: "JPY", value: "2220" })).toEqual({ currency: "JPY", minor: 2220 });
    expect(() => parsePayPalMoney({ value: "1.00" })).toThrow();
    expect(() => parsePayPalMoney(null)).toThrow();
  });
});
