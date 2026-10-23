import fc from "fast-check";
import type { CurrencyCode, FxRate } from "../types";

// Shared fast-check generators for the engine's property tests.

export const RUNS = 1000;

export const CURRENCIES: CurrencyCode[] = ["USD", "EUR", "JPY", "GBP", "CAD", "AUD"];

/** A positive decimal rate string with up to 6 decimals, never zero. */
export const arbRate = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 6 }), fc.nat())
    .map(([whole, decimals, seed]) => {
      const frac = decimals === 0 ? "" : String(seed % 10 ** decimals).padStart(decimals, "0");
      const rate = decimals === 0 ? String(whole) : `${whole}.${frac}`;
      return /^[0.]+$/.test(rate) ? "1" : rate;
    });

export const arbFx = (): fc.Arbitrary<FxRate> =>
  fc
    .tuple(fc.constantFrom(...CURRENCIES), fc.constantFrom(...CURRENCIES), arbRate())
    .map(([base, quote, rate]) => ({
      base,
      quote,
      rate: base === quote ? "1" : rate,
      source: "property-test",
      asOf: "2026-10-23",
    }));
