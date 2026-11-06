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

describe("stripThinking", () => {
  it("removes Nova's thinking, closed or cut off, before the guard and the reader", () => {
    expect(stripThinking("<thinking>I add $21.45 + $8.55</thinking>\nYou paid $21.45.")).toBe("You paid $21.45.");
    expect(stripThinking("You paid $21.45. <thinking>maybe $99")).toBe("You paid $21.45.");
    expect(checkAnswer(stripThinking("<thinking>$99.99</thinking>You paid $21.45."), MARK).ok).toBe(true);
  });
});
