import type { CurrencyCode, Money } from "../core/types";

// PayPal amounts are decimal strings; we keep integer minor units.
// Zero-decimal currencies per PayPal's currency-codes reference.
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);
const KNOWN: ReadonlySet<string> = new Set<CurrencyCode>(["USD", "EUR", "JPY", "GBP", "CAD", "AUD"]);

export function decimalsOf(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function isCurrencyCode(code: string): code is CurrencyCode {
  return KNOWN.has(code);
}

/** Money -> PayPal value string. Throws before anything is sent if the amount cannot be expressed. */
export function toPayPalValue(money: Money): string {
  const { currency, minor } = money;
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported currency: ${currency}`);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Amount must be a whole number of minor units (${currency} ${minor})`);
  }
  if (minor < 0) throw new Error(`Amount must not be negative (${currency} ${minor})`);
  if (decimalsOf(currency) === 0) return String(minor);
  const cents = String(minor % 100).padStart(2, "0");
  return `${Math.floor(minor / 100)}.${cents}`;
}

export function toPayPalMoney(money: Money): { currency_code: string; value: string } {
  return { currency_code: money.currency, value: toPayPalValue(money) };
}

/** PayPal value string -> Money. Rejects malformed values and fractions a currency cannot carry. */
export function fromPayPalValue(currency: string, value: string): Money {
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported currency in PayPal response: ${currency}`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`Malformed PayPal amount: ${currency} ${value}`);
  const decimals = decimalsOf(currency);
  let frac = m[2] ?? "";
  // Trailing zeros carry no value ("3000.00" JPY is still whole yen).
  while (frac.length > decimals && frac.endsWith("0")) frac = frac.slice(0, -1);
  if (frac.length > decimals) throw new Error(`Too many decimals for ${currency}: ${value}`);
  const minor = Number(m[1] + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error(`Amount out of range: ${currency} ${value}`);
  return { currency, minor };
}

/** Accepts both Orders/Payments ({currency_code}) and Payouts ({currency}) money shapes. */
export function parsePayPalMoney(raw: unknown): Money {
  const o = raw as { currency_code?: string; currency?: string; value?: string } | null;
  const currency = o?.currency_code ?? o?.currency;
  if (!currency || typeof o?.value !== "string") throw new Error(`Not a PayPal money object: ${JSON.stringify(raw)}`);
  return fromPayPalValue(currency, o.value);
}
