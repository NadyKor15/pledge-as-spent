import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateReceipt } from "../../src/receipts/structure";
import { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { classificationsFromWire, minorUnits, ModelOutputError, receiptFromText } from "../../src/receipts/wire";
import { cls, receipt } from "./fixtures";

// The plain-text answers of the readers and the classifier, parsed back into receipt rows and line classifications,
// then checked by the full schemas.

const kvs = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join("; ");
/** The receipt as the reader model answers: plain text, one row per line. */
function answer(r: ParsedReceipt): string {
  return [
    `RECEIPT: ${kvs({ merchant: r.merchantName, address: r.merchantAddress, country: r.country, currency: r.currency, purchased: r.purchasedAt, number: r.receiptNumber, subtotal: r.subtotalMinor, tax: r.taxMinor, tax_included: r.taxIncluded, total: r.totalMinor, readability: r.readability })}`,
    ...r.lines.map((l) => `LINE: ${kvs({ no: l.lineNo, qty: l.qty, unit: l.unitPriceMinor, amount: l.amountMinor, rate: l.taxRateBp, text: l.rawText, en: l.translationEn })}`),
    ...r.pii.map((p) => `PII: ${kvs({ kind: p.kind, box: p.bbox ? [p.bbox.x, p.bbox.y, p.bbox.w, p.bbox.h].join(",") : null, text: p.text })}`),
  ].join("\n");
}
const usage = { model: "m", tokensIn: 1800, tokensOut: 400, usdCeiling: 0.01, usdActual: 0.001 };
const lines = z.array(LineClassification);

describe("the reader's answer", () => {
  it("reads back to the same receipt, personal data with and without a box", () => {
    const r = receipt({ pii: [{ kind: "card_number", text: "************1234", bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } }, { kind: "name", text: "A B", bbox: null }], subtotalMinor: 1500 });
    expect(ParsedReceipt.parse(receiptFromText(answer(r)))).toEqual(r);
  });

  it("reads the model's habits: chatter and code fences around the rows, bullets, null spelled out, amounts with symbols, decimals, odd key order and case", () => {
    const text = [
      "Here is the receipt:",
      "```",
      "RECEIPT: merchant=Corner Shop; currency=usd; purchased=2026-11-04T15:58:00; total=$51.41; subtotal=49.18; tax=2.23; tax_included=false; readability=Good; country=null",
      "- LINE: no=1; qty=6; unit=1.49; amount=8.94; rate=null; text=SPRING WATER 1GAL; en=Spring water",
      "LINE: amount: -1,20; text=COUPON; en=Coupon; no=2",
      "LINE: text=SUBTOTAL; en=Subtotal; amount=null",
      "line: no=9; amount=799; text=AA 8PK; ok; en=AA batteries; rate=725",
      "PII: kind=card; box=0.1,0.2,0.3,0.04; text=****1234",
      "PII: (illegible)",
      "PII: kind=name; text=null",
      "```",
    ].join("\n");
    const out = ParsedReceipt.parse(receiptFromText(text));
    expect(out).toMatchObject({ merchantName: "Corner Shop", currency: "USD", totalMinor: 5141, subtotalMinor: 4918, taxMinor: 223, taxIncluded: false, readability: "good", country: null, merchantAddress: null });
    expect(out.lines).toEqual([
      { lineNo: 1, qty: 6, unitPriceMinor: 149, amountMinor: 894, taxRateBp: null, rawText: "SPRING WATER 1GAL", translationEn: "Spring water" },
      { lineNo: 2, qty: null, unitPriceMinor: null, amountMinor: -120, taxRateBp: null, rawText: "COUPON", translationEn: "Coupon" },
      { lineNo: 3, qty: null, unitPriceMinor: null, amountMinor: 799, taxRateBp: 725, rawText: "AA 8PK; ok", translationEn: "AA batteries" },
    ]);
    expect(out.pii).toEqual([{ kind: "other", bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, text: "****1234" }]);
  });

  it("converts amounts by the printed currency: yen are whole, thousands separators go, other currencies take decimals", () => {
    expect(minorUnits("¥1,298", 0)).toBe(1298);
    expect(minorUnits("1.298", 0)).toBe(1298);
    expect(minorUnits("798", 0)).toBe(798);
    expect(minorUnits("1.49", 0)).toBe(1.49); // not an integer yen: left for the schema to refuse
    expect(minorUnits("x1", 2)).toBe("x1"); // letters are not symbols to drop
    expect(minorUnits("1.234,50", 2)).toBe(123450);
    expect(minorUnits("-0,06", 2)).toBe(-6);
    expect(minorUnits("€ 12.50", 2)).toBe(1250);
    expect(minorUnits("1250", 2)).toBe(1250);
    expect(minorUnits("7.7", 2)).toBe(770);
    expect(minorUnits("1,298", 2)).toBe("1,298"); // thousands or decimals? not guessed
    expect(minorUnits("abc", 2)).toBe("abc");
    expect(minorUnits("-", 2)).toBeNull();
    expect(minorUnits(undefined, 2)).toBeNull();
  });

  it("still refuses what the full schema refuses, and says what the call cost", () => {
    const bad = [
      ["RECEIPT: currency=JPY; total=100; readability=good\nLINE: no=1; amount=x1; text=a; en=b", /lines\.0\.amountMinor|amountMinor/],
      ["RECEIPT: merchant=X; total=100; readability=good", /currency/],
      ["RECEIPT: merchant=X; currency=JPY; readability=good", /totalMinor/],
      ["RECEIPT: merchant=X; currency=JPY; total=100; readability=fine", /readability/],
      ["RECEIPT: merchant=X; currency=JPY; total=1.5; readability=good", /totalMinor/],
    ] as const;
    for (const [t, why] of bad) {
      let err: unknown;
      try {
        validateReceipt(receiptFromText(t), "read", usage, t);
      } catch (e) {
        err = e;
      }
      expect(err, t).toBeInstanceOf(ModelOutputError);
      expect((err as ModelOutputError).message).toMatch(why);
      expect((err as ModelOutputError).usage?.tokensIn).toBe(1800);
      expect((err as ModelOutputError).raw).toBe(t);
    }
  });

  it("refuses an answer without a RECEIPT row", () => {
    expect(() => receiptFromText("Sorry, I cannot read this.")).toThrow(ModelOutputError);
    expect(() => receiptFromText("Sorry, I cannot read this.")).toThrow(/no RECEIPT row/);
  });
});

describe("the classifier's answer", () => {
  it("reads every row when the model writes a literal backslash-n or runs the rows together with semicolons", () => {
    for (const glue of ["\\n", "; ", " | ", ". "]) {
      const text = ["no=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Water.", "no=2; verdict=rejected; rule=alcohol; conf=0.9; why=Beer."].join(glue);
      expect(lines.parse(classificationsFromWire({ lines: text })).map((l) => [l.lineNo, l.verdict]), glue).toEqual([[1, "eligible"], [2, "rejected"]]);
    }
  });

  it("one text row per line, tolerant of key case and order", () => {
    const text = "NO=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Water; fine\n\nverdict=rejected; no=2; rule=alcohol; conf=0.9; why=Beer.";
    expect(lines.parse(classificationsFromWire({ lines: text }))).toEqual([
      { lineNo: 1, needId: "water", needQty: 6, verdict: "eligible", ruleCode: null, confidence: 0.95, reasonEn: "Water; fine" },
      { lineNo: 2, needId: null, needQty: null, verdict: "rejected", ruleCode: "alcohol", confidence: 0.9, reasonEn: "Beer." },
    ]);
  });

  it("refuses a row with no fields", () => {
    expect(() => classificationsFromWire({ lines: "just words" })).toThrow(ModelOutputError);
  });

  it("a classification that breaks the schema does not pass it", () => {
    const bad = { ...cls(1), confidence: 3 };
    const text = kvs({ no: bad.lineNo, need: bad.needId, qty: bad.needQty, verdict: bad.verdict, rule: bad.ruleCode, conf: bad.confidence, why: bad.reasonEn });
    expect(lines.safeParse(classificationsFromWire({ lines: text })).success).toBe(false);
  });
});
