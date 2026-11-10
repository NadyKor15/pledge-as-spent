// What a donor types as money, read the way they meant it. Money has at most two decimals, so:
// - a comma or dot before one or two final digits is the decimal mark: "0,80" is 0.80 (never 80), "20,50" is 20.50;
// - groups of three digits may be separated by a comma, a space (also a no-break space) or, when a decimal comma
//   follows, a dot: "1,234.56", "1 234,56", "1.234,56" are all 1234.56, "2,500" is 2500;
// - what could be read two ways is refused rather than guessed: "1.000" (one, or a thousand?), "1,234,56", "0,800".
// JPY has no decimals: digits, grouped by a comma or a space.

export const INPUT_CURRENCIES = ["EUR", "USD", "JPY"] as const;
export type InputCurrency = (typeof INPUT_CURRENCIES)[number];

/** The API's ceiling for one pledge, in major units. */
export const MAX_MAJOR = 10_000;

const PLAIN = /^(\d+)(?:[.,](\d{1,2}))?$/;
// first group without a leading zero, one separator kept throughout, then an optional decimal part
const GROUPED = /^([1-9]\d{0,2})([ ,.])(\d{3}(?:\2\d{3})*)(?:([.,])(\d{1,2}))?$/;
const PLAIN_YEN = /^(\d+)$/;
const GROUPED_YEN = /^([1-9]\d{0,2})([ ,])(\d{3}(?:\2\d{3})*)$/;

function parts(t: string, currency: InputCurrency): { whole: string; cents: string } | null {
  if (currency === "JPY") {
    const p = PLAIN_YEN.exec(t);
    if (p) return { whole: p[1], cents: "" };
    const g = GROUPED_YEN.exec(t);
    return g ? { whole: g[1] + g[3].split(g[2]).join(""), cents: "" } : null;
  }
  const p = PLAIN.exec(t);
  if (p) return { whole: p[1], cents: p[2] ?? "" };
  const g = GROUPED.exec(t);
  if (!g) return null;
  const [, first, sep, rest, mark, cents] = g;
  if (mark !== undefined && mark === sep) return null; // "1,234,56"
  if (mark === undefined && sep === ".") return null; // "1.234": one, or a thousand?
  return { whole: first + rest.split(sep).join(""), cents: cents ?? "" };
}

/**
 * "20.50" or "20,50" EUR -> 2050; "1 234,56" -> 123456; "1,200" JPY -> 1200. Null when it is not money in that
 * currency, is 0, or (unless `ceiling` is false) is above MAX_MAJOR — the ceiling of one pledge, not of a price.
 */
export function toMinor(text: string, currency: InputCurrency, { ceiling = true }: { ceiling?: boolean } = {}): number | null {
  const p = parts(text.trim().replace(/[  ]/g, " "), currency);
  if (!p) return null;
  const whole = Number(p.whole);
  const minor = currency === "JPY" ? whole : whole * 100 + Number(p.cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return !ceiling || minor <= MAX_MAJOR * (currency === "JPY" ? 1 : 100) ? minor : null;
}

/** 80 EUR -> "€0.80", 1200 JPY -> "¥1,200": the value as the server will take it, shown next to the field. */
export function showMinor(minor: number, currency: InputCurrency): string {
  const sign = currency === "EUR" ? "€" : currency === "USD" ? "$" : "¥";
  if (currency === "JPY") return `${sign}${minor.toLocaleString("en-US")}`;
  return `${sign}${Math.floor(minor / 100).toLocaleString("en-US")}.${String(minor % 100).padStart(2, "0")}`;
}
