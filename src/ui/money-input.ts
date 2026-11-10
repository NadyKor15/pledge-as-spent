// What a donor types as money, read the way they meant it. A comma before groups of exactly
// three digits separates thousands ("1,000"); a comma before one or two final digits is the
// decimal mark ("0,80", "20,50"), so a European "0,80" is never read as 80. Anything else
// that could be read two ways ("1.000") is refused rather than guessed.

export const INPUT_CURRENCIES = ["EUR", "USD", "JPY"] as const;
export type InputCurrency = (typeof INPUT_CURRENCIES)[number];

/** The API's ceiling for one pledge, in major units. */
export const MAX_MAJOR = 10_000;

// thousands groups only after a first group without a leading zero: "0,800" is not 800
const WITH_CENTS = /^([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:[.,](\d{1,2}))?$/;
const WHOLE = /^([1-9]\d{0,2}(?:,\d{3})+|\d+)$/;

/** "20.00" or "20,00" EUR -> 2000; "1,000" EUR -> 100000; "1,200" JPY -> 1200; null when not a valid amount (above 0, at most MAX_MAJOR). */
export function toMinor(text: string, currency: InputCurrency): number | null {
  const m = (currency === "JPY" ? WHOLE : WITH_CENTS).exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const minor = currency === "JPY" ? whole : whole * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const max = MAX_MAJOR * (currency === "JPY" ? 1 : 100);
  return Number.isSafeInteger(minor) && minor > 0 && minor <= max ? minor : null;
}

/** 80 EUR -> "€0.80", 1200 JPY -> "¥1,200": the value as the server will take it, shown next to the field. */
export function showMinor(minor: number, currency: InputCurrency): string {
  const sign = currency === "EUR" ? "€" : currency === "USD" ? "$" : "¥";
  if (currency === "JPY") return `${sign}${minor.toLocaleString("en-US")}`;
  return `${sign}${Math.floor(minor / 100).toLocaleString("en-US")}.${String(minor % 100).padStart(2, "0")}`;
}
