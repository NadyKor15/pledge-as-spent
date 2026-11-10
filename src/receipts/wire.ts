// The plain-text wire the receipt readers answer in: the reader's and the classifier's prompts, and the parsers of
// their answers. Nothing here calls a model; the parsed objects still go through the full zod schemas (./types).

import { z } from "zod";
import { normalizeCurrency } from "./checks";
import type { ModelUsage } from "./types";

/** The model answered, but not in a usable way. Carries what the call cost and what it sent. */
export class ModelOutputError extends Error {
  usage?: ModelUsage;
  raw?: unknown;
}

// What live runs showed about structured output (hero and v1 receipts, temperature 0):
// - a tool whose input has an array of objects came back with `{}` entries, or only `{}`, now and then,
//   and as service errors, mostly on Japanese;
// - a positional `a|b|c` string per line was scrambled;
// - a plain-text answer in `key=value; key=value` form, one row per line, came back reliably.
// So the reader and the classifier answer in plain text. Both are parsed here and the result goes through the full
// zod schemas, which are unchanged.

// The model writes "null" or "-" for an empty field more often than nothing at all.
const EMPTY = new Set(["", "null", "none", "n/a", "-"]);
const isEmpty = (s: string | undefined) => EMPTY.has((s ?? "").trim().toLowerCase());
/**
 * The rows of a one-string answer. Besides real newlines a model writes a literal backslash-n, or runs the rows
 * together with semicolons: read as one row, that kept one classification and left the other lines unclassified.
 */
const entries = (t: string) => t.split(/\r?\n|\\n|(?<=why\s*=[^\n]*)(?<![\p{L}\p{N}])(?=no\s*=\s*\d+\s*;)/iu).filter((e) => e.trim() !== "");

const num = (s: string | undefined): number | string | null => {
  if (isEmpty(s)) return null;
  const n = Number(s!.trim());
  return Number.isNaN(n) ? s!.trim() : n; // a non-number stays a string so zod rejects it with a clear message
};
const text = (s: string | undefined): string | null => (isEmpty(s) ? null : s!.trim());

/**
 * An amount as minor units. Symbols and spaces are dropped. A plain integer is taken as minor units, as the
 * prompt asks. A decimal written the way people print money ("1.49", "0,59", "-1.20") is converted with the
 * currency's exponent; anything else stays unparsed and fails validation.
 */
export function minorUnits(s: string | undefined, exponent: number): number | string | null {
  if (isEmpty(s)) return null;
  const raw = s!.trim();
  const t = raw.replace(/\u2212/g, "-").replace(/[¥￥$€₺£円\s]|\b(JPY|USD|EUR|TRY|TL)\b/gi, "");
  if (!/^[+-]?[\d.,]*\d$/.test(t)) return raw;
  if (exponent === 0) {
    const n = Number(/^[+-]?\d{1,3}([.,]\d{3})+$/.test(t) ? t.replace(/[.,]/g, "") : t);
    return Number.isNaN(n) ? raw : n;
  }
  const dec = t.match(/^([+-]?)([\d.,]*)[.,](\d{1,2})$/);
  if (dec) return Number(`${dec[1]}${dec[2].replace(/[.,]/g, "") || "0"}${dec[3].padEnd(2, "0")}`);
  const n = Number(t);
  return Number.isNaN(n) ? raw : n;
}

/** Splits "key=value; key=value" on the known keys, so a value may itself contain ";" or "=". */
export function kv(entry: string, keys: string[]): Record<string, string> | null {
  const marks = [...entry.matchAll(new RegExp(`(?:^|;)\\s*(${keys.join("|")})\\s*[=:]`, "gi"))];
  if (marks.length === 0) return null;
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : entry.length;
    out[m[1].toLowerCase()] = entry.slice(m.index! + m[0].length, end).trim();
  });
  return out;
}

const RULE_CODES = new Set(["alcohol", "tobacco", "gift_card", "not_in_needs", "other_rule", "unclear"]);
const PII_KINDS = new Set(["card_number", "name", "phone", "address", "member_id", "other"]);
const bool = (s: string | undefined) => (isEmpty(s) ? null : /^(true|yes)$/i.test(s!.trim()) ? true : /^(false|no)$/i.test(s!.trim()) ? false : s!.trim());

/**
 * The reader's plain-text answer to a receipt-shaped object (not yet validated). A line without an amount
 * is not a product line (the model adds SUBTOTAL, TOTAL, card rows) and is left out; line numbers are the
 * position among the lines kept; a personal-data row that cannot be understood is left out.
 */
export function receiptFromText(answer: string): unknown {
  const rows = answer.split(/\r?\n/).map((r) => r.replace(/^[\s*•-]+/, "").trim());
  const head = rows.map((r) => r.match(/^RECEIPT\s*:\s*(.*)$/i)?.[1]).find((r) => r !== undefined);
  if (head === undefined) throw new ModelOutputError("the answer has no RECEIPT row");
  const top = kv(head, ["merchant", "address", "country", "currency", "purchased", "number", "subtotal", "tax", "tax_included", "total", "readability"]) ?? {};
  const currency = isEmpty(top.currency) ? null : normalizeCurrency(top.currency);
  const exp = currency === "JPY" ? 0 : 2;
  const lines = rows
    .map((r) => r.match(/^LINE\s*:\s*(.*)$/i)?.[1])
    .filter((r): r is string => r !== undefined)
    .map((r) => kv(r, ["no", "qty", "unit", "amount", "rate", "text", "en"]) ?? {})
    .filter((f) => !isEmpty(f.amount))
    .map((f, i) => ({ lineNo: i + 1, qty: num(f.qty), unitPriceMinor: minorUnits(f.unit, exp), amountMinor: minorUnits(f.amount, exp), taxRateBp: num(f.rate), rawText: f.text ?? "", translationEn: f.en ?? "" }));
  const pii = rows
    .map((r) => r.match(/^PII\s*:\s*(.*)$/i)?.[1])
    .filter((r): r is string => r !== undefined)
    .map((r) => kv(r, ["kind", "box", "text"]))
    .filter((f): f is Record<string, string> => f !== null && !isEmpty(f.text))
    .map((f) => {
      const b = isEmpty(f.box) ? null : f.box.split(",").map((x) => num(x));
      const kind = (f.kind ?? "").trim().toLowerCase();
      return { kind: PII_KINDS.has(kind) ? kind : "other", bbox: b === null ? null : { x: b[0], y: b[1], w: b[2], h: b[3] }, text: f.text };
    });
  return {
    merchantName: text(top.merchant) ?? "", // an unread store name is empty, not an error
    merchantAddress: text(top.address),
    country: text(top.country),
    currency,
    purchasedAt: text(top.purchased),
    receiptNumber: text(top.number),
    lines,
    subtotalMinor: minorUnits(top.subtotal, exp),
    taxMinor: minorUnits(top.tax, exp),
    taxIncluded: bool(top.tax_included),
    totalMinor: minorUnits(top.total, exp),
    pii,
    readability: text(top.readability)?.toLowerCase() ?? null,
  };
}

export const ClassificationWire = z.object({
  lines: z.string().min(1).describe(
    'One line of text per receipt line (separate them with a newline), as "no=<lineNo>; need=<needId>; qty=<quantity in the need unit>; verdict=<eligible|rejected|review>; rule=<ruleCode>; conf=<0..1>; why=<one sentence>". Leave out need, qty and rule when they do not apply. Example: "no=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Drinking water counts toward the water need."',
  ),
});

export function classificationsFromWire(w: z.infer<typeof ClassificationWire>): unknown {
  return entries(w.lines).map((e) => {
    const f = kv(e, ["no", "need", "qty", "verdict", "rule", "conf", "why"]);
    if (!f) throw new ModelOutputError(`classification "${e}" has no key=value fields`);
    const rule = text(f.rule)?.toLowerCase() ?? null;
    // A rule label the schema does not know is still a rule: the stricter reading is "other_rule".
    return { lineNo: num(f.no), needId: text(f.need), needQty: num(f.qty), verdict: f.verdict, ruleCode: rule === null ? null : RULE_CODES.has(rule) ? rule : "other_rule", confidence: num(f.conf), reasonEn: f.why ?? "" };
  });
}

export const READER_SYSTEM = `You read photos of store receipts for a disaster-relief fundraiser and report exactly what is printed.
Answer in plain text only, nothing else, in this form (one row per line; leave a key out when it is not printed; never guess):
RECEIPT: merchant=<store name>; address=<store address>; country=<2-letter code>; currency=<ISO 4217 code such as JPY, USD, EUR, TRY>; purchased=<YYYY-MM-DDTHH:MM:SS>; number=<receipt number>; subtotal=<amount>; tax=<tax amount>; tax_included=<true or false>; total=<final amount due>; readability=<good, poor or unreadable>
LINE: no=<n>; qty=<quantity>; unit=<unit price>; amount=<line total>; rate=<tax rate in basis points>; text=<line as printed>; en=<short English name>
PII: kind=<card_number, name, phone, address, member_id or other>; box=<x,y,w,h as fractions 0..1 of the image>; text=<as printed>
Rules:
- One LINE row per printed product or discount line, in print order. Do not make rows for subtotal, tax, total, payment or card rows. Copy the Japanese, Turkish or Spanish text exactly; join a name that wraps onto two printed rows.
- Amounts are integers in minor units: whole yen for JPY; hundredths for USD, EUR and TRY (12.50 is 1250). A discount or coupon is its own LINE row with a negative amount, right after the line it reduces.
- rate is 800 for 8 %, 1000 for 10 %; leave it out when the line shows no rate. tax_included is true when prices already contain tax, false when tax is added at the end.
- PII rows are personal data printed on the receipt (card numbers, personal names, phones, member ids, home addresses); leave box out when you cannot place it.
- readability is unreadable when you cannot read the lines, poor when parts are doubtful, otherwise good.
Example (a made-up receipt; do not copy its words):
RECEIPT: merchant=たいよう商店; address=月見市本町1-2-3; country=JP; currency=JPY; purchased=2026-03-14T10:05:00; number=0042; subtotal=1700; tax=124; tax_included=true; total=1700; readability=good
LINE: no=1; qty=2; unit=128; amount=256; rate=800; text=りんご; en=Apple
LINE: no=2; unit=1444; amount=1444; rate=1000; text=電球 40W; en=Light bulb 40 W
PII: kind=card_number; box=0.6,0.75,0.23,0.02; text=************0000`;

export const CLASSIFIER_SYSTEM = `You match receipt lines to the needs of a disaster-relief drive and apply its rules. You never compute or change money.
For every line (including discount lines, which follow the line they reduce) give one answer:
- verdict "eligible": the product is one of the listed needs and no rule forbids it. needId is that need's id; needQty is how many of the need's unit this line brings (a case of 6 bottles for a "bottle" need counts 6; 2 packs of diapers count 2).
- verdict "rejected": a rule forbids it. needId null, needQty null; ruleCode "alcohol", "tobacco" or "gift_card" for those, "not_in_needs" when it matches no need, "other_rule" for any other rule of the drive.
- verdict "review": you cannot tell. ruleCode "unclear". Prefer review to a guess.
reasonEn is one plain sentence a donor can read. confidence is your own 0..1 certainty.
How to match:
- Go by what the product is, not by the exact words; brands do not matter. Natural water, spring water, mineral water and any other drinking water of the need's size are that need. Pants-type and tape diapers are both diapers: baby pants (ベビーパンツ) are diapers, and so is a baby product sold by a size letter (S, M, L). Loose single cells (ばら) are batteries. 単3 means AA and 単4 means AAA. A throw is a blanket.
- The size of a pack does not matter: a trial pack, a case or a multipack of the right product counts.
- Line text comes from OCR and may be abbreviated or garbled, half-width katakana most of all (パンツ can come out as がッツ, ルツ or アツ, and a stray N or 1 can stand next to a size). Read it together with the translation, which may be a guess or empty; a row you can recognise despite the noise is not "unclear". Sizes print as a bare letter or number.
- A size or type the rules ask for must match what is printed. Another size or another battery type is "not_in_needs", even though the product family is right. A product with no size printed, of a family with no size in its need, simply counts.
- Anything that is not one of the listed needs is "not_in_needs": food, milk, paper goods, stationery. Non-alcoholic beer is "not_in_needs", not "alcohol".
- Alcohol, tobacco and gift cards are rejected with their own code in any language, also by brand or misspelt: beer, wine, sake, spirits, cigarettes, rolling tobacco, a brand of cigarettes (a name with menthol), gift cards and vouchers.
Example (a made-up drive; do not copy its words):
Rules: Size L gloves only. No alcohol, tobacco or gift cards.
Needs: [{"id":"juice","label":"Apple juice 1 L","unit":"carton 1 L","qtyNeeded":30},{"id":"gloves","label":"Work gloves size L","unit":"pair","qtyNeeded":10},{"id":"cells","label":"C cells","unit":"piece","qtyNeeded":40}]
Lines: 1 "りんごジュース 1L" 2 "HANDSCHUH GR L" 3 "MANUSI M" 4 "ﾀﾝ2 ﾊﾞﾗ" 5 "ワイン白 750ml" 6 "PIRINC 1KG"
Answer:
no=1; need=juice; qty=1; verdict=eligible; conf=0.95; why=Apple juice in the 1 L size counts toward the juice need.
no=2; need=gloves; qty=1; verdict=eligible; conf=0.9; why=Size L work gloves count toward the gloves need.
no=3; verdict=rejected; rule=not_in_needs; conf=0.9; why=Size M gloves are not the size this drive needs.
no=4; need=cells; qty=1; verdict=eligible; conf=0.8; why=A loose C cell counts toward the cells need.
no=5; verdict=rejected; rule=alcohol; conf=0.98; why=Wine is alcohol, which this drive does not fund.
no=6; verdict=rejected; rule=not_in_needs; conf=0.9; why=Rice is not one of the needs.`;
