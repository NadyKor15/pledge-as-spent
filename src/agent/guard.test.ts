import { describe, expect, it } from "vitest";
import { checkAnswer, correction, extractClaims, stripThinking } from "./guard";
import { parseNumber } from "./money-parse";
import type { Fact } from "./types";

// Synthetic facts only: each case says what the book returned, so a pass or a block is decided by the
// guard and not by whatever a fixture happens to contain (must-light on synthetic, rule 16).
const MARK: Fact[] = [
  { value: 30, currency: "USD", label: "pledged" },
  { value: 21.45, currency: "USD", label: "spent" },
  { value: 8.58, currency: "USD", label: "line 4", lineKey: "r1:4" },
  { value: 10.89, currency: "USD", label: "line 5", lineKey: "r1:5" },
  { value: 1.98, currency: "USD", label: "line 6", lineKey: "r1:6" },
  { value: 8.55, currency: "USD", label: "released" },
  { value: 0, label: "capture", id: "5PE922386K0983923" },
];

const claims = (t: string) => extractClaims(t).map((c) => (c.kind === "id" ? c.id : `${c.currency ?? "?"} ${c.value}`));

describe("extractClaims: money as donors write it", () => {
  it("reads EN, DE and JA forms, symbols and codes before or after", () => {
    expect(claims("You paid $21.45 and US$ 8.58")).toEqual(["USD 21.45", "USD 8.58"]);
    expect(claims("Davon 4,58 € ausgegeben, 15,42 € zurück")).toEqual(["EUR 4.58", "EUR 15.42"]);
    expect(claims("Insgesamt 1.234,56 € und EUR 3,10")).toEqual(["EUR 1234.56", "EUR 3.1"]);
    expect(claims("合計 ¥10,448、10 448 円、1,237円")).toEqual(["JPY 10448", "JPY 10448", "JPY 1237"]);
    expect(claims("total 1,234.56 USD; 1,486 JPY; £2.50; CA$4.00")).toEqual(["USD 1234.56", "JPY 1486", "GBP 2.5", "CAD 4"]);
    expect(claims("¥1,237円")).toEqual(["JPY 1237"]);
  });

  it("full-width digits are read like ASCII", () => {
    expect(claims("￥１，２３７")).toEqual(["JPY 1237"]);
  });

  it("bare numbers: two decimals, or integers above 100", () => {
    expect(claims("Lines 4, 5 and 6 cost 8.58, 10,89 and 1486 in total; 12 bottles; 99")).toEqual(["? 8.58", "? 10.89", "? 1486"]);
  });

  it("dates, times, years, quantities with units are not claims", () => {
    expect(claims("On 2026-11-05 at 14:32, 5 Nov 2026, 05.11.2026, 2026年11月5日, in 2026, 350ml beer, 44 枚")).toEqual([]);
  });

  it("PayPal ids are claims, and their digits are not numbers", () => {
    expect(claims("capture 5PE922386K0983923 and batch NPUW3BEC9J8TC")).toEqual(["5PE922386K0983923", "NPUW3BEC9J8TC"]);
  });

  it("parseNumber decides the decimal mark by shape", () => {
    expect([parseNumber("1,234.56"), parseNumber("1.234,56"), parseNumber("4,58"), parseNumber("1,237"), parseNumber("10 448"), parseNumber("21.45")]).toEqual([1234.56, 1234.56, 4.58, 1237, 10448, 21.45]);
  });
});

describe("checkAnswer: numbers only from the book (must-light)", () => {
  it("a planted made-up figure blocks; the same sentence with the book's figure passes", () => {
    const bad = checkAnswer("Your hold paid $21.47 for diapers.", MARK);
    expect(bad.ok).toBe(false);
    expect(bad.unmatched.map((c) => c.raw)).toEqual(["$21.47"]);
    const good = checkAnswer("Your hold paid $21.45 for diapers.", MARK);
    expect(good).toMatchObject({ ok: true, unmatched: [] });
    expect(good.checked.map((c) => c.raw)).toEqual(["$21.45"]);
  });

  it('"$3000" for a $30.00 pledge (minor units read as dollars) blocks; "$30.00" passes', () => {
    expect(checkAnswer("Mark pledged $3000.", MARK).ok).toBe(false);
    expect(checkAnswer("Mark pledged $30.00.", MARK).ok).toBe(true);
    expect(checkAnswer("Mark pledged 3000.", MARK).ok).toBe(false);
  });

  it("a made-up PayPal id blocks; the real one passes", () => {
    expect(checkAnswer("PayPal capture 5PE922386K0983924.", MARK).ok).toBe(false);
    expect(checkAnswer("PayPal capture 5PE922386K0983923.", MARK).ok).toBe(true);
  });

  it("a sum the model worked out itself blocks when the book has no such total", () => {
    const facts = MARK.filter((f) => f.value !== 30);
    const v = checkAnswer("$21.45 + $8.55 = $30.00", facts);
    expect(v.ok).toBe(false);
    expect(v.unmatched.map((c) => c.raw)).toEqual(["$30.00"]);
  });

  it("a figure that appeared only in a delegate's complete_task summary does not count", () => {
    // The registry never takes complete_task output as facts; the guard sees only what tools returned.
    const facts: Fact[] = [{ value: 1486, currency: "JPY", label: "water, all shares" }];
    const summary = "Water received ¥1,500 in total."; // what a delegate wrote
    expect(checkAnswer(`Studio's data agent says: ${summary}`, facts).ok).toBe(false);
    expect(checkAnswer("Water received ¥1,486 in total.", facts).ok).toBe(true);
  });

  it("DE and JA forms pass against the book's figures", () => {
    const facts: Fact[] = [
      { value: 4.58, currency: "EUR", label: "spent" },
      { value: 15.42, currency: "EUR", label: "released" },
      { value: 1237, currency: "JPY", label: "spent" },
    ];
    expect(checkAnswer("Ausgegeben 4,58 €, zurück 15,42 €.", facts, "de").ok).toBe(true);
    expect(checkAnswer("使われたのは¥1,237です。", facts, "ja").ok).toBe(true);
    expect(checkAnswer("使われたのは1,237円です。", facts, "ja").ok).toBe(true);
    expect(checkAnswer("Ausgegeben 4,59 €.", facts, "de").ok).toBe(false);
  });

  it("a currency must match: €21.45 is not $21.45", () => {
    expect(checkAnswer("You paid €21.45.", MARK).ok).toBe(false);
  });

  it("dates, line numbers and small counts are not checked", () => {
    expect(checkAnswer("Lines 4, 5 and 6 (3 packs) on 5 Nov 2026 at 14:32 cost $21.45.", MARK).ok).toBe(true);
  });

  it("the correction names each figure once", () => {
    const v = checkAnswer("$3000 and $3000 and 5PE922386K0983924", MARK);
    expect(correction(v.unmatched)).toBe("Your answer contained figures not returned by the tools: $3000, 5PE922386K0983924; use only tool figures or say you cannot confirm.");
  });
});

describe("percentages and words for a share: only what a tool returned (must-light)", () => {
  // Lena: €4.58 of €20.00 spent (22.9 %), €15.42 back (77.1 %); PayPal took all of what was spent.
  const LENA: Fact[] = [
    { value: 20, currency: "EUR", label: "pledged" },
    { value: 4.58, currency: "EUR", label: "spent" },
    { value: 15.42, currency: "EUR", label: "back" },
    { value: 22.9, unit: "%", topic: "spent", label: "share of the pledge spent" },
    { value: 77.1, unit: "%", topic: "back", label: "share of the pledge back" },
    { value: 100, unit: "%", topic: "captured", label: "share of the spend PayPal took" },
  ];

  it("Nova Lite's own answer to Q6 of the live measure (06.11, variant A) is stopped: \"zu 100% … ausgegeben\" for €4.58 of €20", () => {
    const q6 = "Lena, dein €20.00 Hold wurde zu 100% für die Bedürfnisse ausgegeben. €4.58 wurden für Wasser 2 L ausgegeben. Der Rest von €15.42 wurde nicht ausgegeben und wurde dir zurückgegeben, als die Aktion geschlossen wurde.";
    const v = checkAnswer(q6, LENA, "de");
    expect(v.ok).toBe(false);
    expect(v.unmatched.map((c) => c.raw)).toEqual(["100%"]);
  });

  it("the true share passes: \"23 %\" spent, \"77 %\" back, \"22.9%\"", () => {
    expect(checkAnswer("Ausgegeben wurden 23 % deines Holds, 77 % kamen zurück.", LENA, "de").ok).toBe(true);
    expect(checkAnswer("You spent 22.9% of your pledge.", LENA).ok).toBe(true);
    expect(checkAnswer("You spent 22% of your pledge.", LENA).ok).toBe(false);
  });

  it("a percentage of the wrong kind is stopped: 100 % taken by PayPal is true, 100 % back is not", () => {
    expect(checkAnswer("PayPal took all of it.", LENA).ok).toBe(true);
    expect(checkAnswer("All of it came back to you.", LENA).ok).toBe(false);
    expect(checkAnswer("Alles kam zu dir zurück.", LENA, "de").ok).toBe(false);
    expect(checkAnswer("全額が戻りました。", LENA, "ja").ok).toBe(false);
  });

  it("without any share fact, a share word is stopped; an amount is never matched by a percentage or the reverse", () => {
    const amounts = LENA.filter((f) => f.unit !== "%");
    expect(checkAnswer("The whole pledge was spent.", amounts).ok).toBe(false);
    expect(checkAnswer("You paid €100.", [{ value: 100, unit: "%", label: "x" }]).ok).toBe(false);
    expect(checkAnswer("You paid 20%.", [{ value: 20, currency: "EUR", label: "x" }]).ok).toBe(false);
  });

  it("claims: percent signs and words in three languages, one claim per phrase", () => {
    const shares = (t: string) => extractClaims(t).filter((c) => c.kind === "share").map((c) => `${c.value}${c.topic ? `:${c.topic}` : ""}`);
    expect(shares("zu 100% ausgegeben")).toEqual(["100:spent"]);
    expect(shares("23 % ausgegeben, 77 Prozent zurück")).toEqual(["23:spent", "77:back"]);
    expect(shares("全額が戻りました")).toEqual(["100:back"]);
    expect(shares("12 of 40 bottles; all donors gave; insgesamt")).toEqual([]);
  });
});

describe("stripThinking", () => {
  it("removes a model's thinking, closed or cut off, before the guard and the reader", () => {
    expect(stripThinking("<thinking>I add $21.45 + $8.55</thinking>\nYou paid $21.45.")).toBe("You paid $21.45.");
    expect(stripThinking("You paid $21.45. <thinking>maybe $99")).toBe("You paid $21.45.");
    expect(checkAnswer(stripThinking("<thinking>$99.99</thinking>You paid $21.45."), MARK).ok).toBe(true);
  });
});

// The README's list of what the check finds and what it misses ("Numbers only from the book"), pinned form by form.
// Each row is synthetic text; a change to the parser that changes a row must change the README too.
describe("README: the forms the check finds and the ones it misses", () => {
  const amount = (text: string) => extractClaims(text).filter((c) => c.kind === "amount").map((c) => ({ value: c.value, currency: c.currency }));

  it("finds an amount with a currency symbol at any size, before (all) or after ($ € ¥ 円)", () => {
    expect(amount("$5")).toEqual([{ value: 5, currency: "USD" }]);
    expect(amount("US$ 7")).toEqual([{ value: 7, currency: "USD" }]);
    expect(amount("C$3")).toEqual([{ value: 3, currency: "CAD" }]);
    expect(amount("CA$3")).toEqual([{ value: 3, currency: "CAD" }]);
    expect(amount("A$3")).toEqual([{ value: 3, currency: "AUD" }]);
    expect(amount("AU$3")).toEqual([{ value: 3, currency: "AUD" }]);
    expect(amount("€2")).toEqual([{ value: 2, currency: "EUR" }]);
    expect(amount("£2")).toEqual([{ value: 2, currency: "GBP" }]);
    expect(amount("¥9")).toEqual([{ value: 9, currency: "JPY" }]);
    expect(amount("4,58 €")).toEqual([{ value: 4.58, currency: "EUR" }]);
    expect(amount("9$")).toEqual([{ value: 9, currency: "USD" }]);
    expect(amount("9¥")).toEqual([{ value: 9, currency: "JPY" }]);
    expect(amount("10 448 円")).toEqual([{ value: 10448, currency: "JPY" }]);
    expect(amount("￥１，２３７")).toEqual([{ value: 1237, currency: "JPY" }]);
    expect(amount("$1,234.56 and 1.234,56 €")).toEqual([
      { value: 1234.56, currency: "USD" },
      { value: 1234.56, currency: "EUR" },
    ]);
  });

  it("finds an ISO code in capitals before or after the number", () => {
    for (const code of ["USD", "EUR", "JPY", "GBP", "CAD", "AUD"]) {
      expect(amount(`${code} 12`)).toEqual([{ value: 12, currency: code }]);
      expect(amount(`12 ${code}`)).toEqual([{ value: 12, currency: code }]);
    }
  });

  it("finds a bare number with two decimals or above 100, and leaves years, dates, times and quantities alone", () => {
    expect(amount("it was 21.45")).toEqual([{ value: 21.45, currency: undefined }]);
    expect(amount("line total 101")).toEqual([{ value: 101, currency: undefined }]);
    expect(amount("line total 100")).toEqual([]);
    expect(amount("in 2026, on 2026-11-06 at 14:30, 2 L and 3 枚")).toEqual([]);
  });

  it("finds a PayPal id in capitals: 17 characters, or 13 to 20 with a digit and a letter", () => {
    const ids = (t: string) => extractClaims(t).filter((c) => c.kind === "id").map((c) => c.id);
    expect(ids("capture 5PE922386K0983923")).toEqual(["5PE922386K0983923"]);
    expect(ids("order 8MA225382G0217")).toEqual(["8MA225382G0217"]);
    expect(ids("ABCDEFGHIJKLMNOPQRS")).toEqual([]); // 19 letters, no digit
  });

  it("finds a share as a percentage or as words for all or half of it", () => {
    const shares = (t: string) => extractClaims(t).filter((c) => c.kind === "share").map((c) => c.value);
    expect(shares("23 % was spent")).toEqual([23]);
    expect(shares("zu 23 Prozent ausgegeben")).toEqual([23]);
    expect(shares("23パーセント使われました")).toEqual([23]);
    for (const w of ["all of it", "in full", "ganz", "vollständig", "全額", "全部"]) expect(shares(`spent ${w}`)).toEqual([100]);
    for (const w of ["half of it", "die Hälfte", "半分"]) expect(shares(`spent ${w}`)).toEqual([50]);
  });

  it("misses: currency words are not a currency (a word after 100 or less is no claim; above 100 it is a bare number)", () => {
    expect(extractClaims("20 euros")).toEqual([]);
    expect(extractClaims("20 Euro")).toEqual([]);
    expect(extractClaims("21 dollars")).toEqual([]);
    expect(amount("1,237 yen")).toEqual([{ value: 1237, currency: undefined }]);
    // so a bare 1,237 passes against ¥1,237 or $1,237 alike
    expect(checkAnswer("1,237 yen", [{ value: 1237, currency: "USD", label: "x" }]).ok).toBe(true);
  });

  it("misses: 万 and 千 do not multiply (\"1万円\" and \"2千\" are no claim at all)", () => {
    expect(extractClaims("1万円")).toEqual([]);
    expect(extractClaims("2千円")).toEqual([]);
    expect(extractClaims("2千")).toEqual([]);
  });

  it("misses: an ISO code in small letters is not a currency, and a lower-case id is no claim", () => {
    expect(amount("usd 21.45")).toEqual([{ value: 21.45, currency: undefined }]);
    expect(extractClaims("capture 5pe922386k0983923")).toEqual([]);
  });
  it("misses: a bare number with one decimal, a code in mixed case, a currency the check does not know, and other words for a share", () => {
    expect(extractClaims("it was 21.5")).toEqual([]);
    expect(extractClaims("Eur 99")).toEqual([]);
    expect(extractClaims("CHF 99")).toEqual([]);
    expect(extractClaims("すべて使われました")).toEqual([]);
    expect(extractClaims("it was spent completely")).toEqual([]);
    expect(extractClaims("a third of it")).toEqual([]);
  });

  it("misses: a bare number with decimals matches the same value in any currency", () => {
    expect(checkAnswer("It cost 21.45 in euros.", [{ value: 21.45, currency: "USD", label: "spent" }]).ok).toBe(true);
  });
});
