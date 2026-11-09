import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lineGross, lineMoney, lineName, lineViews, refusedTotal, taxUnknown } from "../../src/ui/derive";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { lineProof } from "../../src/ui/ledger/proof";
import type { DriveView, LedgerRow, Receipt, ReceiptLine } from "../../src/ui/types";

// A line on the screens is what the book funds: its printed price plus its share of the tax printed on top. A
// discount has no rows of its own in the book (it is netted into the line above), so it shares that line's fate.

const line = (lineNo: number, amount: number, tax: number | null, over: Partial<ReceiptLine> = {}) =>
  ({ lineNo, text: `line ${lineNo}`, translationEn: "", amount, tax, verdict: "eligible", needId: null, needQty: null, ruleCode: null, reasonEn: null, confidence: 0.9, box: null, ...over }) as ReceiptLine;

const share = (lineNo: number, base: number, needId = "canned") => ({ receiptId: "r1", lineNo, kind: "donor_share", needId, qty: 2, base, reasonEn: null, status: "accrued" }) as unknown as LedgerRow;
const refused = (lineNo: number, base: number, reasonEn = "Not a need of this drive.") => ({ receiptId: "r1", lineNo, kind: "rejected", needId: null, qty: null, base, reasonEn, status: "rejected" }) as unknown as LedgerRow;

const view = (ledger: LedgerRow[]) => ({ ledger, needs: [{ needId: "canned", displayLabel: "Canned food" }] }) as unknown as DriveView;
const receipt = (status: string, lines: ReceiptLine[]) => ({ id: "r1", status, lines, decision: null }) as unknown as Receipt;

// A mackerel line with the coupon under it, then a refused line: ¥396 + ¥31 tax, −¥40 − ¥3, ¥1,380 + ¥138.
const LINES = [line(1, 396, 31, { needId: "canned", needQty: 2, translationEn: "Canned mackerel" }), line(2, -40, -3, { needId: "canned", needQty: 0, translationEn: "Discount" }), line(3, 1380, 138, { verdict: "rejected", translationEn: "Underwear L" })];

describe("a line's gross", () => {
  it("is the printed price plus its share of the tax on top; a tax inside the prices adds nothing", () => {
    expect(lineGross({ amount: 472, tax: 38 })).toBe(510);
    expect(lineGross({ amount: -40, tax: -3 })).toBe(-43);
    expect(lineGross({ amount: 2596, tax: 0 })).toBe(2596);
    // A view saved before the field existed reads as tax inside.
    expect(lineGross({ amount: 2596 })).toBe(2596);
  });

  it("an unknown share leaves the printed price, marked before tax", () => {
    expect(taxUnknown({ amount: 472, tax: null })).toBe(true);
    expect(taxUnknown({ amount: 472, tax: 0 })).toBe(false);
    expect(taxUnknown({ amount: 472 })).toBe(false);
    expect(lineGross({ amount: 472, tax: null })).toBe(472);
    expect(lineMoney("JPY", { amount: 472, tax: null })).toBe("¥472 before tax");
    expect(lineMoney("JPY", { amount: 472, tax: 38 })).toBe("¥510");
    expect(lineMoney("USD", { amount: 1299, tax: 104 })).toBe("$14.03");
  });
});

describe("a discount shares the fate of the line above it", () => {
  it("funded line: the coupon is on the kept side, named by its own text, with no need or quantity", () => {
    const lines = lineViews(view([share(1, 192), share(1, 192), refused(3, 1518)]), receipt("funded", LINES));
    expect(lines.map((l) => l.state)).toEqual(["approved", "approved", "rejected"]);
    const coupon = lines[1];
    expect(coupon.need).toBeUndefined();
    expect(coupon.qty).toBeNull();
    expect(coupon.shares).toEqual([]);
    expect(lineName(coupon).title).toBe("Discount");
    expect(refusedTotal(lines)).toBe(1518);
  });

  it("refused line: the coupon is refused with it, and the refused total is net of it, with tax", () => {
    const lines = lineViews(view([refused(1, 427), refused(3, 1518)]), receipt("funded", LINES));
    expect(lines.map((l) => l.state)).toEqual(["rejected", "rejected", "rejected"]);
    expect(refusedTotal(lines)).toBe(427 - 43 + 1518);
  });

  it("before the book has it: the coupon waits, or needs a decision, with its line", () => {
    expect(lineViews(view([]), receipt("review", LINES)).map((l) => l.state)).toEqual(["pending", "pending", "rejected"]);
    const held = [{ ...LINES[0], verdict: "review" }, { ...LINES[1], verdict: "eligible" }, LINES[2]] as ReceiptLine[];
    expect(lineViews(view([]), receipt("review", held)).map((l) => l.state)).toEqual(["review", "review", "rejected"]);
  });

  it("a discount with rows of its own (the whole receipt refused, or no line above it) keeps its own fate", () => {
    const all = lineViews(view([refused(1, 427, "Total does not match."), refused(2, 0, "Total does not match."), refused(3, 1518, "Total does not match.")]), receipt("rejected", LINES));
    expect(all[1].reason).toBe("Total does not match.");
    const orphan = [line(1, -40, -3), line(2, 396, 31, { needId: "canned", needQty: 2 })];
    const lines = lineViews(view([refused(1, 0, "A discount with no line above it."), share(2, 427)]), receipt("funded", orphan));
    expect(lines.map((l) => [l.state, l.reason])).toEqual([
      ["rejected", "A discount with no line above it."],
      ["approved", null],
    ]);
  });
});

describe("the Ledger proof of a line whose tax share is unknown", () => {
  it("says the printed price is before tax, in each language", () => {
    const closed = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/drives/closed.json"), "utf8")) as DriveView;
    const MARK4 = closed.ledger.find((r) => r.receiptId === closed.receipts[0].id && r.lineNo === 4 && r.kind === "donor_share")!.rowId;
    // The sample's tax is inside its prices: unchanged.
    expect(lineProof(closed, deriveLedger(closed), MARK4)!.sentence).toMatch(/^Line 4 · Soft kids diapers M · ¥2,596 = /);
    const unknown = structuredClone(closed);
    unknown.receipts[0].lines[3] = { ...unknown.receipts[0].lines[3], tax: null };
    expect(lineProof(unknown, deriveLedger(unknown), MARK4)!.sentence).toMatch(/^Line 4 · Soft kids diapers M · ¥2,596 before tax = /);
    expect(lineProof(unknown, deriveLedger(unknown, "de"), MARK4, "de")!.sentence).toContain("2.596 ¥ vor Steuer = ");
    expect(lineProof(unknown, deriveLedger(unknown, "ja"), MARK4, "ja")!.sentence).toContain("税抜 = ");
  });
});

describe("the refused total", () => {
  it("adds refused lines with their tax, so refused + kept is the receipt's total", () => {
    const lines = lineViews(view([share(1, 192), share(1, 192), refused(3, 1518)]), receipt("funded", LINES));
    const kept = lines.filter((l) => l.state !== "rejected").reduce((s, l) => s + lineGross(l.line), 0);
    expect(refusedTotal(lines) + kept).toBe(396 + 31 - 40 - 3 + 1380 + 138);
    // Without tax (the old sum) it would be ¥1,380 against a total that has ¥166 of tax in it.
    expect(refusedTotal(lines)).not.toBe(1380);
  });
});
