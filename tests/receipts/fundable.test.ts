import { describe, expect, it } from "vitest";
import { toFundableLines } from "../../src/receipts/checks";
import { cls, drive, line, needs, receipt } from "./fixtures";

const run = (r = receipt(), c = [cls(1, { needQty: 6 }), cls(2, { needId: "diapers", needQty: 2 })], progress = {}, d = drive, minConfidence?: number) =>
  toFundableLines(r, c, needs, d, progress, { receiptId: "rcpt-1", minConfidence });

describe("toFundableLines", () => {
  it("funds approved lines with the receipt id", () => {
    expect(run()).toEqual({
      fundable: [
        { receiptId: "rcpt-1", lineNo: 1, needId: "water", needQty: 6, amountBase: 1000 },
        { receiptId: "rcpt-1", lineNo: 2, needId: "diapers", needQty: 2, amountBase: 500 },
      ],
      rejected: [],
    });
  });

  it("rejects by rule with the model's reason", () => {
    const out = run(undefined, [cls(1, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol", reasonEn: "Beer is not allowed." }), cls(2, { needId: "diapers", needQty: 1 })]);
    expect(out.rejected).toEqual([{ lineNo: 1, code: "alcohol", reasonEn: "Beer is not allowed." }]);
    expect(out.fundable.map((f) => f.lineNo)).toEqual([2]);
  });

  it("defaults a rejection without a rule code to other_rule", () => {
    expect(run(undefined, [cls(1, { verdict: "rejected", ruleCode: null }), cls(2)]).rejected[0].code).toBe("other_rule");
  });

  it("holds back review verdicts, low confidence and unclassified lines", () => {
    const out = run(undefined, [cls(1, { verdict: "review", ruleCode: "unclear" })]);
    expect(out.rejected.map((x) => [x.lineNo, x.code])).toEqual([[1, "review"], [2, "unclassified"]]);
    expect(run(undefined, [cls(1, { confidence: 0.69 }), cls(2, { confidence: 0.7 })]).rejected.map((x) => [x.lineNo, x.code])).toEqual([[1, "low_confidence"]]);
    expect(run(undefined, [cls(1, { confidence: 0.8 }), cls(2, { confidence: 0.8 })], {}, drive, 0.9).fundable).toEqual([]);
  });

  it("refuses conflicting classifications of one line, and with them the whole receipt", () => {
    const out = run(undefined, [cls(1), cls(1, { needId: "diapers" }), cls(2)]);
    expect(out.rejected).toMatchObject([{ lineNo: 1, code: "review" }, { lineNo: 2, code: "review" }]);
    expect(out.fundable).toEqual([]);
  });

  it("rejects unknown needs, needs of another drive and bad quantities", () => {
    const out = run(undefined, [cls(1, { needId: "nope" }), cls(2, { needId: null })]);
    expect(out.rejected.map((x) => x.code)).toEqual(["unknown_need", "unknown_need"]);
    const other = toFundableLines(receipt(), [cls(1), cls(2)], needs.map((n) => ({ ...n, driveId: "other" })), drive, {}, { receiptId: "r" });
    expect(other.rejected.map((x) => x.code)).toEqual(["unknown_need", "unknown_need"]);
    expect(run(undefined, [cls(1, { needQty: null }), cls(2, { needQty: 0 })]).rejected.map((x) => x.code)).toEqual(["bad_qty", "bad_qty"]);
  });

  it("rejects a line whose amount after discount is not positive", () => {
    const r = receipt({ lines: [line(1, 300), line(2, -300)], totalMinor: 0 });
    expect(run(r, [cls(1)]).rejected).toMatchObject([{ lineNo: 1, code: "non_positive_amount" }]);
  });

  it("nets a discount line into the line above and does not list it", () => {
    const r = receipt({ lines: [line(1, 1000), line(2, -150), line(3, 500)], totalMinor: 1350 });
    const out = run(r, [cls(1, { needQty: 5 }), cls(3, { needId: "diapers", needQty: 1 })]);
    expect(out.fundable.map((f) => [f.lineNo, f.amountBase])).toEqual([[1, 850], [3, 500]]);
    expect(out.rejected).toEqual([]);
  });

  it("drops a discount with nothing above it", () => {
    const r = receipt({ lines: [line(1, -100), line(2, 600)], totalMinor: 500 });
    const out = run(r, [cls(2, { needQty: 1 })]);
    expect(out.rejected).toMatchObject([{ lineNo: 1, code: "orphan_discount" }]);
    expect(out.fundable).toHaveLength(1);
  });

  it("adds each line's share of tax that is printed on top", () => {
    const r = receipt({ lines: [line(1, 3000, 1000), line(2, 1000, 1000)], taxIncluded: false, taxMinor: 400, totalMinor: 4400 });
    const out = run(r, [cls(1, { needQty: 3 }), cls(2, { needId: "diapers", needQty: 1 })]);
    expect(out.fundable.map((f) => f.amountBase)).toEqual([3300, 1100]);
    expect(out.fundable.reduce((s, f) => s + f.amountBase, 0)).toBe(4400);
  });

  it("keeps a discount's tax share with its line", () => {
    const r = receipt({ lines: [line(1, 1000, 1000), line(2, -200, 1000)], taxIncluded: false, taxMinor: 80, totalMinor: 880 });
    expect(run(r, [cls(1, { needQty: 1 })]).fundable[0].amountBase).toBe(880);
  });

  it("funds only what a need still lacks, pro rata and rounded down", () => {
    const out = run(receipt({ lines: [line(1, 1001), line(2, 500)], totalMinor: 1501 }), [cls(1, { needId: "diapers", needQty: 3 }), cls(2, { needId: "diapers", needQty: 2 })], { diapers: 4 });
    // 2 packs remain: line 1 (3 packs, 1001) gets 2/3 -> 667; the need is then full.
    expect(out.fundable).toEqual([{ receiptId: "rcpt-1", lineNo: 1, needId: "diapers", needQty: 2, amountBase: 667 }]);
    expect(out.rejected).toMatchObject([{ lineNo: 2, code: "need_full" }]);
  });

  it("counts earlier lines of the same receipt against the need", () => {
    const out = run(receipt({ lines: [line(1, 600), line(2, 400)], totalMinor: 1000 }), [cls(1, { needId: "diapers", needQty: 5 }), cls(2, { needId: "diapers", needQty: 5 })]);
    expect(out.fundable.map((f) => [f.lineNo, f.needQty, f.amountBase])).toEqual([[1, 5, 600], [2, 1, 80]]);
  });

  it("rejects a need that is already covered, and a sliver that rounds to nothing", () => {
    expect(run(undefined, [cls(1, { needQty: 1 }), cls(2, { needId: "diapers", needQty: 1 })], { water: 40, diapers: 6 }).rejected.map((x) => x.code)).toEqual(["need_full", "need_full"]);
    const r = receipt({ lines: [{ ...line(1, 1), qty: 1000 }], totalMinor: 1 });
    // 1000 printed units, 1000 claimed: plausible; only one unit of the need is still open, worth 1/1000 of a yen.
    expect(run(r, [cls(1, { needQty: 1000 })], { water: 39 }).rejected[0].code).toBe("need_full");
  });

  it("refuses the whole receipt when the drive is closed, currency differs or totals do not add up", () => {
    const closed = run(undefined, undefined, {}, { ...drive, status: "closed" });
    expect(closed.fundable).toEqual([]);
    expect(closed.rejected.map((x) => x.code)).toEqual(["drive_closed", "drive_closed"]);
    expect(run(receipt({ currency: "USD" })).rejected.map((x) => x.code)).toEqual(["currency_mismatch", "currency_mismatch"]);
    expect(run(receipt({ totalMinor: 1 })).rejected.map((x) => x.code)).toEqual(["total_mismatch", "total_mismatch"]);
    expect(run(receipt({ lines: [line(1, 0), line(2, 0)], taxIncluded: false, taxMinor: 50, totalMinor: 50 })).rejected.map((x) => x.code)).toEqual(["tax_unallocatable", "tax_unallocatable"]);
  });

  it("still takes receipts while the drive is closing", () => {
    expect(run(undefined, undefined, {}, { ...drive, status: "closing" }).fundable).toHaveLength(2);
  });
});
