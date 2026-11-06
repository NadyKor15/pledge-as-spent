// The figures a written answer claims, in the forms donors read them: EN "$1,234.56", DE "1.234,56 €",
// JA "¥10,448" / "10 448 円", ISO codes before or after the number, PayPal ids. The guard checks each
// claim against the book; this file only finds them. Dates, times, quantities with a unit and small
// counts are not claims.

export type AgentLocale = "en" | "de" | "ja";

export interface Claim {
  kind: "amount" | "id";
  /** The text as written, e.g. "4,58 €". */
  raw: string;
  start: number;
  end: number;
  /** Major units (21.45 for "$21.45", 1237 for "¥1,237"). */
  value?: number;
  /** ISO code when the answer names a currency; absent for a bare number. */
  currency?: string;
  /** A PayPal id as written. */
  id?: string;
}

const CODES = "USD|EUR|JPY|GBP|CAD|AUD";

/** Symbol or code before the number -> ISO code. Longest first, so "CA$" is not read as "$". */
const PREFIX: [string, string][] = [
  ["US$", "USD"],
  ["CA$", "CAD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["C$", "CAD"],
  ["$", "USD"],
  ["€", "EUR"],
  ["¥", "JPY"],
  ["£", "GBP"],
];

const SUFFIX: Record<string, string> = { "€": "EUR", 円: "JPY", $: "USD", "¥": "JPY" };

const esc = (s: string) => s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");

// A number with optional grouping. Groups of three may be split by "," "." "'" or a (narrow/no-break)
// space, the decimal part is one or two digits after "." or ",".
const GROUPED = String.raw`\d{1,3}(?:[,.'\u00A0\u202F ]\d{3})+(?:[.,]\d{1,2})?`;
const PLAIN = String.raw`\d+(?:[.,]\d{1,2})?`;
const NUM = `(?:${GROUPED}|${PLAIN})`;
/** A number standing alone: grouped by "," "." or "'" only, so "lines 4 100" stays two numbers. */
const BARE = String.raw`(?:\d{1,3}(?:[,.']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;

const PREFIX_RE = PREFIX.map(([s]) => esc(s)).join("|");
const AMOUNT_BEFORE = new RegExp(String.raw`(?<![\w$€¥£])(${PREFIX_RE}|(?:${CODES})(?=[\s\u00A0]?\d))[\s\u00A0]?[-−]?(${NUM})(?![\d])`, "g");
const AMOUNT_AFTER = new RegExp(String.raw`(?<![\w.,'])(${NUM})[\s\u00A0\u202F]?(€|円|\$|¥|(?:${CODES})\b)`, "g");

const IDS = [/(?<![0-9A-Za-z])[0-9A-Z]{17}(?![0-9A-Za-z])/g, /(?<![0-9A-Za-z])(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{13,20}(?![0-9A-Za-z])/g];

const MONTHS_EN = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const MONTHS_DE = "Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember";

/** Spans that look like numbers but are not money: dates, times, quantities with a unit. */
const NOT_CLAIMS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g,
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
  /\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|\d{1,2}月\d{1,2}日/g,
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\.?\s+(?:${MONTHS_EN}|${MONTHS_DE})\.?(?:,?\s+\d{4})?`, "g"),
  new RegExp(String.raw`\b(?:${MONTHS_EN}|${MONTHS_DE})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?`, "g"),
  new RegExp(String.raw`\b(?:${MONTHS_EN}|${MONTHS_DE})\s+\d{4}\b`, "g"),
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\d+(?:[.,]\d+)?\s?(?:ml|mL|m(?![a-z])|l(?![a-z])|L(?![a-z])|g(?![a-z])|kg|cm|mm|%|枚|本|個|缶|入|袋|パック|ピース|pcs\b|pieces?\b|bottles?\b|packs?\b|cans?\b|Stück\b|Flaschen\b|Packungen\b)/g,
];

/** Full-width digits and marks -> ASCII, one character for one, so positions stay the same. */
export function normalizeDigits(text: string): string {
  return text.replace(/[０-９，．￥]/g, (c) => (c === "，" ? "," : c === "．" ? "." : c === "￥" ? "¥" : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
}

/**
 * "1,234.56" / "1.234,56" / "10 448" / "4,58" / "21.45" -> 1234.56 / 1234.56 / 10448 / 4.58 / 21.45.
 * The shape decides: the last separator followed by one or two digits is the decimal mark, a
 * separator followed by three digits groups thousands.
 */
export function parseNumber(s: string): number {
  const t = s.replace(/[\u00A0\u202F ']/g, " ");
  const m = /^(.*?)([.,])(\d{1,2})$/.exec(t);
  const whole = (m ? m[1] : t).replace(/[ ,.]/g, "");
  const frac = m ? m[3] : "";
  return Number(frac ? `${whole}.${frac}` : whole);
}

function prefixCode(token: string): string {
  const t = token.trim();
  const hit = PREFIX.find(([s]) => s === t);
  return hit ? hit[1] : t.toUpperCase();
}

function overlaps(spans: [number, number][], start: number, end: number) {
  return spans.some(([a, b]) => start < b && end > a);
}

/** Every figure the text claims, in order. `locale` is the language the answer was asked in. */
export function extractClaims(text: string, locale: AgentLocale = "en"): Claim[] {
  void locale; // the number shapes above are unambiguous for money; kept for the callers' symmetry
  const s = normalizeDigits(text);
  const claims: Claim[] = [];
  const taken: [number, number][] = [];
  const take = (c: Claim) => {
    claims.push(c);
    taken.push([c.start, c.end]);
  };

  for (const re of IDS) {
    for (const m of s.matchAll(re)) {
      const start = m.index!;
      if (!overlaps(taken, start, start + m[0].length)) take({ kind: "id", raw: m[0], start, end: start + m[0].length, id: m[0] });
    }
  }

  const amounts: Claim[] = [];
  for (const m of s.matchAll(AMOUNT_BEFORE)) {
    const start = m.index!;
    amounts.push({ kind: "amount", raw: text.slice(start, start + m[0].length), start, end: start + m[0].length, value: parseNumber(m[2]), currency: prefixCode(m[1]) });
  }
  for (const m of s.matchAll(AMOUNT_AFTER)) {
    const start = m.index!;
    const unit = m[2];
    amounts.push({ kind: "amount", raw: text.slice(start, start + m[0].length), start, end: start + m[0].length, value: parseNumber(m[1]), currency: SUFFIX[unit] ?? unit.toUpperCase() });
  }
  // "¥1,237円" or "€ 4,58 €": the longer reading wins, each digit belongs to one claim.
  amounts.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  for (const a of amounts) if (!overlaps(taken, a.start, a.end)) take(a);

  const skip: [number, number][] = [...taken];
  for (const re of NOT_CLAIMS) for (const m of s.matchAll(re)) skip.push([m.index!, m.index! + m[0].length]);

  for (const m of s.matchAll(new RegExp(`(?<![\\w.,])${BARE}(?![\\w])`, "g"))) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(skip, start, end)) continue;
    const raw = m[0];
    const decimals = /[.,]\d{2}$/.test(raw) && !/^\d{1,3}([.,]\d{3})+$/.test(raw);
    const value = parseNumber(raw);
    const grouped = /^\d{1,3}([,.'\u00A0\u202F ]\d{3})+$/.test(raw);
    const year = !grouped && /^\d{4}$/.test(raw) && value >= 1900 && value <= 2099;
    if (decimals || (value > 100 && !year)) take({ kind: "amount", raw: text.slice(start, end), start, end, value });
  }
  return claims.sort((a, b) => a.start - b.start);
}
