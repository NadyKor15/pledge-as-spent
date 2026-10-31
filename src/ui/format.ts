// Display formatting. Amounts arrive as integer minor units with their currency.

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", JPY: "¥", GBP: "£", CAD: "CA$", AUD: "A$" };
const ZERO_DECIMAL = new Set(["JPY"]);

export const decimals = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : 2);

export function money(currency: string | null | undefined, minor: number | null | undefined): string {
  if (!currency || minor === null || minor === undefined) return "";
  const d = decimals(currency);
  const s = (Math.abs(minor) / 10 ** d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${minor < 0 ? "−" : ""}${SYMBOL[currency] ?? `${currency} `}${s}`;
}

/** "Lena (Berlin)" + "DE" -> { name: "Lena", place: "Berlin, DE" }. */
export function donorParts(donorName: string, country?: string | null): { name: string; place: string | null } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(donorName);
  const name = (m ? m[1] : donorName).trim();
  const city = m ? m[2].trim() : null;
  const place = [city, country].filter(Boolean).join(", ");
  return { name, place: place || null };
}

export const shortName = (donorName: string) => donorParts(donorName).name;

/** "bottle 2 L" -> "bottle", "gallon jug" -> "jug"; "piece" counts carry no unit word. */
function unitNoun(unit: string): string | null {
  const words = unit.trim().split(/\s+/);
  const noun = /\d/.test(unit) ? words[0] : words[words.length - 1];
  return !noun || noun === "piece" ? null : noun;
}

const plural = (noun: string, n: number) => (n === 1 ? noun : /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`);

/** "12 of 40 bottles"; "50 of 50" for pieces. */
export function ofCount(covered: number, needed: number, unit: string): string {
  const noun = unitNoun(unit);
  return `${covered} of ${needed}${noun ? ` ${plural(noun, needed)}` : ""}`;
}

/** "12 bottles", "6 packs", "50". */
export function qtyText(qty: number, unit: string): string {
  const noun = unitNoun(unit);
  return noun ? `${qty} ${plural(noun, qty)}` : String(qty);
}

/** "12 bottles of drinking water 2 L", "50 AA batteries". */
export function itemPhrase(qty: number, unit: string, label: string): string {
  const noun = unitNoun(unit);
  return noun ? `${qty} ${plural(noun, qty)} of ${label.charAt(0).toLowerCase()}${label.slice(1)}` : `${qty} ${label}`;
}

/** [1,2,3,5] -> "1–3, 5". */
export function lineRange(nos: number[]): string {
  const s = [...new Set(nos)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return parts.join(", ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Date part of an ISO string (zoned or local) -> "5 Nov 2026" / "5 Nov". */
export function day(iso: string | null | undefined, withYear = true): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return "";
  const d = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return withYear ? `${d} ${m[1]}` : d;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** "Kitasora Community Shelter — Earthquake relief" -> its two parts. */
export function titleParts(title: string): { head: string; tail: string | null } {
  const i = title.indexOf(" — ");
  return i < 0 ? { head: title, tail: null } : { head: title.slice(0, i), tail: title.slice(i + 3) };
}

const UPPER = (s: string) => s.replace(/_/g, " ").toUpperCase();
export const statusLabel = UPPER;

/** Bar split in percent, rounded to 0.01 so the parts add up to 100. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);
