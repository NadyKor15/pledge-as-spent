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

/** The languages the Ledger speaks. */
export type Lang = "en" | "de" | "ja";

const INTL: Record<Lang, string> = { en: "en-US", de: "de-DE", ja: "ja-JP" };
const formats = new Map<string, Intl.NumberFormat>();

/** Intl's parts with the page's own signs: a true minus, the narrow yen sign, plain spaces. */
function intlMoney(lang: Lang, currency: string, major: number, digits: number): string {
  const key = `${lang}:${currency}:${digits}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(INTL[lang], { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
    formats.set(key, f);
  }
  return f
    .formatToParts(major)
    .map((p) => (p.type === "minusSign" ? "−" : p.type === "currency" ? p.value.replace("￥", "¥") : p.type === "literal" ? p.value.replace(/[  ]/g, " ") : p.value))
    .join("");
}

/**
 * money() in the reader's language: "1.234,56 €" in German, "¥10,448" in Japanese; English is money() itself.
 * money() stays English whatever the page shows: the Telegram bot and the server print it.
 */
export function moneyIn(lang: Lang, currency: string | null | undefined, minor: number | null | undefined): string {
  if (lang === "en" || !currency || minor === null || minor === undefined) return money(currency, minor);
  const d = decimals(currency);
  return intlMoney(lang, currency, minor / 10 ** d, d);
}

/** rateText() in the reader's language: "1 € = 162,35 ¥" in German. */
export function rateTextIn(lang: Lang, fx: { base: string; quote: string; rate: string } | null | undefined): string | null {
  if (lang === "en") return rateText(fx);
  if (!fx || fx.base === fx.quote) return null;
  const places = fx.rate.split(".")[1]?.length ?? 0;
  return `${intlMoney(lang, fx.quote, 1, 0)} = ${intlMoney(lang, fx.base, Number(fx.rate), places)}`;
}

/** "€1 = ¥162.35": one unit of the pledge's currency in the drive's. */
export function rateText(fx: { base: string; quote: string; rate: string } | null | undefined): string | null {
  if (!fx || fx.base === fx.quote) return null;
  const sign = (c: string) => SYMBOL[c] ?? `${c} `;
  return `${sign(fx.quote)}1 = ${sign(fx.base)}${fx.rate}`;
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

/** "Kitasora Community Shelter — Earthquake relief" -> "Kitasora Shelter", as the Ledger's card calls it. */
export const shelterShort = (title: string) => titleParts(title).head.replace(/\bCommunity\s+/, "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Date part of an ISO string (zoned or local) -> "5 Nov 2026" / "5 Nov". */
export function day(iso: string | null | undefined, withYear = true): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return "";
  const d = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return withYear ? `${d} ${m[1]}` : d;
}

const UTC_DATE: Record<Lang, [string, Intl.DateTimeFormatOptions["month"]]> = { en: ["en-US", "short"], de: ["de-DE", "short"], ja: ["ja-JP", "long"] };

/**
 * "Nov 1, 02:06 UTC": the day and time PayPal answered, in UTC, so every reader sees the same moment. Not "7 days
 * ago": a relative time on a drive opened days before reads as if the money moved before the receipt.
 */
export function whenUtc(lang: Lang, iso: string): string {
  const [locale, month] = UTC_DATE[lang];
  return `${new Intl.DateTimeFormat(locale, { month, day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(iso))} UTC`;
}

/** "Kitasora Community Shelter — Earthquake relief" -> its two parts. */
export function titleParts(title: string): { head: string; tail: string | null } {
  const i = title.indexOf(" — ");
  return i < 0 ? { head: title, tail: null } : { head: title.slice(0, i), tail: title.slice(i + 3) };
}

/** Bar split in percent, rounded to 0.01 so the parts add up to 100. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);
