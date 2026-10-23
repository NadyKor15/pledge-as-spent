import { CoreError } from "./errors";
import type { CurrencyCode, FxRate, Money } from "./types";

// Money is integer minor units end to end; FX is exact BigInt rational
// arithmetic with an explicit rounding mode, so no float ever touches an amount.

export type RoundingMode = "half-up" | "floor" | "ceil";

/** An exact non-negative rational number. `den` is always > 0. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

// PayPal sends these without a fractional part; every other supported code has two.
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);

export function currencyExponent(code: string): number {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new CoreError("invalid_currency", `not an ISO 4217 code: ${JSON.stringify(code)}`);
  }
  return ZERO_DECIMAL.has(code) ? 0 : 2;
}

export function assertMinor(minor: number, what = "amount"): void {
  if (!Number.isSafeInteger(minor)) {
    throw new CoreError("invalid_amount", `${what} must be an integer number of minor units, got ${minor}`);
  }
}

export function money(currency: CurrencyCode, minor: number): Money {
  currencyExponent(currency);
  assertMinor(minor);
  return { currency, minor };
}

/** Minor units -> PayPal `value` string: JPY 3000 -> "3000", EUR 2000 -> "20.00". */
export function formatAmount(amount: { currency: string; minor: number }): string {
  const exp = currencyExponent(amount.currency);
  assertMinor(amount.minor);
  const negative = amount.minor < 0;
  const digits = BigInt(Math.abs(amount.minor)).toString();
  if (exp === 0) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(exp + 1, "0");
  const whole = padded.slice(0, padded.length - exp);
  const frac = padded.slice(padded.length - exp);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** PayPal `value` string -> minor units. More decimals than the currency has is an error. */
export function parseAmount(currency: string, value: string): number {
  const exp = currencyExponent(currency);
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(value);
  if (!m || (m[2] === "" && m[3] === undefined)) {
    throw new CoreError("invalid_amount", `not a decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, frac = ""] = m;
  if (frac.length > exp) {
    throw new CoreError(
      "invalid_amount",
      `${currency} takes ${exp} decimal places, got ${JSON.stringify(value)}`,
    );
  }
  const minor = BigInt((whole || "0") + frac.padEnd(exp, "0")) * (sign === "-" ? -1n : 1n);
  const n = toSafeNumber(minor);
  return n === 0 ? 0 : n;
}

export function parseRate(rate: string): Ratio {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) throw new CoreError("invalid_rate", `not a positive decimal rate: ${JSON.stringify(rate)}`);
  const [, whole, frac = ""] = m;
  const num = BigInt(whole + frac);
  if (num === 0n) throw new CoreError("invalid_rate", `rate must be > 0, got ${JSON.stringify(rate)}`);
  return { num, den: 10n ** BigInt(frac.length) };
}

export function validateFx(fx: FxRate): void {
  currencyExponent(fx.base);
  currencyExponent(fx.quote);
  const r = parseRate(fx.rate);
  if (fx.base === fx.quote && r.num !== r.den) {
    throw new CoreError("invalid_rate", `same-currency rate must be 1, got ${fx.rate}`);
  }
}

/** Base minor units per one quote minor unit, exactly. */
export function minorRate(fx: FxRate): Ratio {
  const r = parseRate(fx.rate);
  const eb = 10n ** BigInt(currencyExponent(fx.base));
  const eq = 10n ** BigInt(currencyExponent(fx.quote));
  return { num: r.num * eb, den: r.den * eq };
}

export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) throw new CoreError("invalid_amount", "division by a non-positive number");
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  switch (mode) {
    case "floor":
      return n < 0n ? q - 1n : q;
    case "ceil":
      return n > 0n ? q + 1n : q;
    case "half-up": {
      // Half away from zero, the usual banking reading of "half-up".
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice >= d) return n < 0n ? q - 1n : q + 1n;
      return q;
    }
  }
}

/** Pledge currency (quote) -> drive currency (base), at the pledge's locked rate. */
export function toBase(quoteMinor: number, fx: FxRate, mode: RoundingMode = "half-up"): number {
  assertMinor(quoteMinor);
  const k = minorRate(fx);
  return toSafeNumber(divRound(BigInt(quoteMinor) * k.num, k.den, mode));
}

/** Drive currency (base) -> pledge currency (quote), at the pledge's locked rate. */
export function toQuote(baseMinor: number, fx: FxRate, mode: RoundingMode = "half-up"): number {
  assertMinor(baseMinor);
  const k = minorRate(fx);
  return toSafeNumber(divRound(BigInt(baseMinor) * k.den, k.num, mode));
}

export function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CoreError("invalid_amount", `amount out of safe integer range: ${n}`);
  }
  return Number(n);
}
