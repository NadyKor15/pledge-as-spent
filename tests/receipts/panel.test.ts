// Fixes from the adversarial acceptance panel. Each test names the panel finding it pins.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocateTax, findDuplicate, normalizeCurrency, toFundableLines } from "../../src/receipts/checks";
import { semanticKey } from "../../src/receipts/hash";
import { JsonlSpendLedger, SpendCap } from "../../src/receipts/spend";
import { BedrockNovaReader, type ConverseClient } from "../../src/receipts/bedrock";
import { receiptFromText } from "../../src/receipts/wire";
import { scoreReceipt } from "../../tools/eval/metrics";
import type { LineClassification } from "../../src/receipts/types";
import { cls, drive, line, needs, receipt } from "./fixtures";

const fund = (r = receipt(), c: LineClassification[] = [cls(1, { needQty: 6 }), cls(2, { needId: "diapers", needQty: 2 })], opts: Record<string, unknown> = {}, progress = {}) =>
  toFundableLines(r, c, needs, drive, progress, { receiptId: "r1", ...opts });
const codes = (x: ReturnType<typeof fund>) => x.rejected.map((r) => `${r.lineNo}:${r.code}`);

describe("panel 1: the classifier's verdict has a deterministic backstop", () => {
  for (const code of ["alcohol", "tobacco", "gift_card", "other_rule"] as const) {
    it(`an eligible line carrying rule code ${code} is rejected with that code`, () => {
      const out = fund(undefined, [cls(1, { ruleCode: code }), cls(2, { needId: "diapers", needQty: 2 })]);
      expect(codes(out)).toEqual([`1:${code}`]);
      expect(out.fundable.map((f) => f.lineNo)).toEqual([2]);
    });
  }
  for (const code of ["not_in_needs", "unclear"] as const) {
    it(`an eligible line carrying rule code ${code} goes to review`, () => {
      expect(codes(fund(undefined, [cls(1, { ruleCode: code }), cls(2, { needId: "diapers", needQty: 2 })]))).toEqual(["1:review"]);
    });
  }
});

describe("panel 2: line numbers must identify lines", () => {
  const dup = receipt({ lines: [line(1, 1000), line(1, 500)], totalMinor: 1500 });
  it("duplicate lineNo in the receipt rejects every line", () => {
    const out = fund(dup, [cls(1, { needQty: 6 })]);
    expect(out.fundable).toEqual([]);
    expect(codes(out)).toEqual(["1:duplicate_line_no", "1:duplicate_line_no"]);
  });
  it("a classification for a line that is not on the receipt sends every line to review", () => {
    const out = fund(undefined, [cls(1, { needQty: 6 }), cls(2, { needId: "diapers", needQty: 2 }), cls(7)]);
    expect(out.fundable).toEqual([]);
    expect(codes(out)).toEqual(["1:review", "2:review"]);
  });
  it("two classifications of one line send every line to review", () => {
    const out = fund(undefined, [cls(1), cls(1, { needId: "diapers" }), cls(2, { needId: "diapers", needQty: 2 })]);
    expect(out.fundable).toEqual([]);
    expect(codes(out)).toEqual(["1:review", "2:review"]);
  });
});

describe("panel 3: needQty is a safe positive integer", () => {
  for (const q of [1.5, 0.5, Number.POSITIVE_INFINITY, 2 ** 60, Number.NaN]) {
    it(`needQty ${q} is rejected as bad_qty`, () => {
      expect(codes(fund(undefined, [cls(1, { needQty: q as number }), cls(2, { needId: "diapers", needQty: 2 })]))).toEqual(["1:bad_qty"]);
    });
  }
});

describe("panel 4: needQty must fit the printed quantity", () => {
  const one = (printed: number | null, claimed: number) => {
    const l = { ...line(1, 1000), qty: printed };
    return fund(receipt({ lines: [l], totalMinor: 1000 }), [cls(1, { needQty: claimed })]);
  };
  it("one printed bottle cannot claim 40 bottles", () => expect(codes(one(1, 40))).toEqual(["1:review"]));
  it("a claim that is not a whole multiple of the printed quantity goes to review", () => expect(codes(one(6, 7))).toEqual(["1:review"]));
  it("a pack larger than 24 units goes to review", () => expect(codes(one(1, 25))).toEqual(["1:review"]));
  it("a case of 6 sold once, 12 bottles sold as 6 x 2, a pack of 24 and an unprinted quantity pass", () => {
    for (const [p, c] of [[1, 6], [6, 12], [1, 24], [2, 48], [null, 1], [null, 6], [10, 10]] as const) expect(one(p, c).fundable, `${p} -> ${c}`).toHaveLength(1);
  });
  it("the review reason says what did not fit", () => {
    expect(one(1, 40).rejected[0].reasonEn).toMatch(/quantity/i);
  });
});

describe("panel 5: a coordinator can approve what the checks held back", () => {
  const approved = { by: "coordinator-7", reason: "Photographed the paper receipt; lines are right." };
  it("without an override a mismatching total refuses the whole receipt", () => {
    expect(fund(receipt({ totalMinor: 1600 })).fundable).toEqual([]);
  });
  it("acceptTotalMismatch funds the read line amounts and records the override", () => {
    const out = fund(receipt({ totalMinor: 1600 }), undefined, { coordinatorApproved: { ...approved, acceptTotalMismatch: true } });
    expect(out.fundable.map((f) => f.amountBase)).toEqual([1000, 500]);
    expect(out.overrides).toEqual({ ...approved, acceptTotalMismatch: true, lineNos: [] });
  });
  it("lineNos funds held-back lines (low confidence, review, implausible quantity) and lists them", () => {
    const l = [cls(1, { needQty: 6, confidence: 0.3 }), cls(2, { needId: "diapers", needQty: 2, verdict: "review", ruleCode: "unclear" })];
    const out = fund(undefined, l, { coordinatorApproved: { ...approved, lineNos: [1, 2] } });
    expect(out.fundable.map((f) => f.lineNo)).toEqual([1, 2]);
    expect(out.overrides?.lineNos).toEqual([1, 2]);
    const only1 = fund(undefined, l, { coordinatorApproved: { ...approved, lineNos: [1] } });
    expect(only1.fundable.map((f) => f.lineNo)).toEqual([1]);
    expect(codes(only1)).toEqual(["2:review"]);
  });
  it("never overrides a forbidden item, a closed drive, a wrong currency or a bad quantity", () => {
    const a = { ...approved, acceptTotalMismatch: true };
    const rule = fund(undefined, [cls(1, { verdict: "rejected", ruleCode: "alcohol", needId: null, needQty: null }), cls(2, { needId: "diapers", needQty: 2 })], { coordinatorApproved: a });
    expect(codes(rule)).toEqual(["1:alcohol"]);
    expect(toFundableLines(receipt(), [cls(1), cls(2)], needs, { ...drive, status: "closed" }, {}, { receiptId: "r", coordinatorApproved: a }).fundable).toEqual([]);
    expect(fund(receipt({ currency: "USD" }), undefined, { coordinatorApproved: a }).fundable).toEqual([]);
    expect(codes(fund(undefined, [cls(1, { needQty: 1.5, confidence: 0.1 }), cls(2, { needId: "diapers", needQty: 2 })], { coordinatorApproved: { ...approved, lineNos: [1] } }))).toEqual(["1:bad_qty"]);
  });
  it("needs a name and a reason", () => {
    expect(() => fund(undefined, undefined, { coordinatorApproved: { by: "", reason: "x" } })).toThrow(/by/);
    expect(() => fund(undefined, undefined, { coordinatorApproved: { by: "a", reason: " " } })).toThrow(/reason/);
  });
});

describe("panel 6: a billed call with no usage in the answer keeps its reservation", () => {
  const est = { textChars: 1000, toolSpecChars: 0, images: 1, maxTokens: 4000 };
  it("SpendCap keeps the worst case when the provider reports no tokens", async () => {
    const ledger = new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "p6-")), "l.jsonl"));
    const out = await new SpendCap(ledger).call({ model: "amazon.nova-lite-v1:0", what: "t", estimate: est }, async () => ({ value: 1, tokensIn: null, tokensOut: null }));
    expect(out.usage.usdActual).toBeNull();
    expect(await ledger.total()).toBeCloseTo(out.usage.usdCeiling, 6);
  });
  it("the Bedrock reader passes a missing usage block through as unknown", async () => {
    const ledger = new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "p6-")), "l.jsonl"));
    const client: ConverseClient = { send: async () => ({ output: { message: { role: "assistant", content: [{ text: "RECEIPT: merchant=X; currency=JPY; total=1; readability=good" }] } }, stopReason: "end_turn", $metadata: {} }) as never };
    const out = await new BedrockNovaReader({ client, cap: new SpendCap(ledger) }).read({ bytes: new Uint8Array([1]), mediaType: "image/png" }, { currency: "JPY", languages: ["ja"] });
    expect(out.usage.usdActual).toBeNull();
    expect(await ledger.total()).toBeCloseTo(out.usage.usdCeiling, 6);
  });
});

describe("panel 7: the semantic duplicate key", () => {
  const base = { merchantName: "ミナト生活館 北空店", purchasedAt: "2026-11-05T14:32:00", totalMinor: 14646 };
  it("is minute-level and survives the usual re-reading: spacing, width, date-time format, seconds", () => {
    const k = semanticKey(base);
    expect(k).not.toBeNull();
    for (const v of [{ merchantName: "ﾐﾅﾄ生活館  北空店" }, { purchasedAt: "2026-11-05 14:32" }, { purchasedAt: "2026-11-05T14:32:59" }, { purchasedAt: "2026-11-05T14:32" }]) expect(semanticKey({ ...base, ...v }), JSON.stringify(v)).toBe(k);
  });
  it("tells a legitimate second receipt of the same day apart", () => {
    const k = semanticKey(base);
    expect(semanticKey({ ...base, purchasedAt: "2026-11-05T14:33:00" })).not.toBe(k);
    expect(semanticKey({ ...base, totalMinor: 14647 })).not.toBe(k);
  });
  it("has no key when the time is missing or the store was not read", () => {
    expect(semanticKey({ ...base, purchasedAt: "2026-11-05" })).toBeNull();
    expect(semanticKey({ ...base, purchasedAt: null })).toBeNull();
    expect(semanticKey({ ...base, merchantName: " " })).toBeNull();
  });
  it("blocks a re-photo and lets the same-day second receipt through", () => {
    const known = [{ receiptId: "a", uploadedAt: "2026-11-05T15:00:00Z", sha256: "x", dHash: null, semanticKey: semanticKey(base) }];
    const fp = (o: object) => ({ sha256: "y", dHash: null, semanticKey: semanticKey({ ...base, ...o }) });
    expect(findDuplicate(fp({ merchantName: "ミナト生活館北空店", purchasedAt: "2026-11-05 14:32:10" }), known)?.kind).toBe("semantic");
    expect(findDuplicate(fp({ purchasedAt: "2026-11-05T18:10:00" }), known)).toBeNull();
    expect(findDuplicate(fp({ purchasedAt: "2026-11-05" }), [{ ...known[0], semanticKey: semanticKey({ ...base, purchasedAt: "2026-11-05" }) }])).toBeNull();
  });
});

describe("panel 8: tax on top follows the net amount of a discounted line", () => {
  it("a coupon printed without a rate takes the rate of the line above, so the discounted line carries tax on its net", () => {
    const r = receipt({ lines: [line(1, 1000, 1000), line(2, -500, null), line(3, 500, 1000)], taxIncluded: false, taxMinor: 100, totalMinor: 1100 });
    // Net taxable = 1000 - 500 + 500 = 1000, tax 100: the net of line 1 and its coupon is 500 -> 50, line 3 -> 50.
    const s = allocateTax(r)!;
    expect(s.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s[0] + s[1]).toBe(50);
    expect(s[2]).toBe(50);
  });
  it("funds the discounted line with its net tax", () => {
    const r = receipt({ lines: [line(1, 1000, 1000), line(2, -500, null), line(3, 500, 1000)], taxIncluded: false, taxMinor: 100, totalMinor: 1100 });
    const out = fund(r, [cls(1, { needQty: 1 }), cls(3, { needId: "diapers", needQty: 1 })]);
    expect(out.fundable.map((f) => f.amountBase)).toEqual([550, 550]);
  });
});

describe("panel 9: currency is compared as an ISO code", () => {
  it("normalises symbols and names", () => {
    for (const [s, iso] of [["¥", "JPY"], ["￥", "JPY"], ["円", "JPY"], ["jpy", "JPY"], [" JPY ", "JPY"], ["€", "EUR"], ["euro", "EUR"], ["$", "USD"], ["US$", "USD"], ["£", "GBP"], ["₺", "TRY"], ["TL", "TRY"]] as const) expect(normalizeCurrency(s), s).toBe(iso);
    expect(normalizeCurrency("XYZ")).toBe("XYZ");
  });
  it("a receipt that says ¥ or 円 matches a JPY drive", () => {
    for (const c of ["¥", "円", "jpy"]) expect(fund(receipt({ currency: c })).fundable, c).toHaveLength(2);
    expect(fund(receipt({ currency: "€" })).fundable).toEqual([]);
  });
  it("the reader stores the ISO code", () => {
    const o = receiptFromText("RECEIPT: merchant=X; currency=¥; total=¥1,298; readability=good") as { currency: string; totalMinor: number };
    expect(o).toMatchObject({ currency: "JPY", totalMinor: 1298 });
    expect((receiptFromText("RECEIPT: merchant=X; currency=€; total=1,50; readability=good") as { currency: string }).currency).toBe("EUR");
  });
});

describe("panel 10: rule lines are found by position and text, not only by amount", () => {
  it("counts a beer whose amount was misread and that the classifier called eligible as funded by mistake", () => {
    const truth = receipt({ lines: [{ ...line(1, 500), rawText: "牛乳 1L" }, { ...line(2, 1198), rawText: "缶ビール 350ml 6缶" }], totalMinor: 1698 });
    const labels = [cls(1, { needQty: 1 }), cls(2, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol" })];
    const pred = { ...truth, lines: [truth.lines[0], { ...truth.lines[1], amountMinor: 1128 }] };
    const predLabels = [cls(1), cls(2, { needQty: 6 })];
    const s = scoreReceipt(truth, labels, pred, predLabels);
    expect(s.ruleLinesFunded).toBe(1);
    expect(s.ruleLines).toEqual({ num: 0, den: 1 });
  });
  it("matches by text when the position moved too", () => {
    const truth = receipt({ lines: [{ ...line(1, 500), rawText: "milk" }, { ...line(2, 1198), rawText: "LAGER 6PK BTL" }], totalMinor: 1698 });
    const labels = [cls(1), cls(2, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol" })];
    const pred = { ...truth, lines: [{ ...line(1, 9), rawText: "extra" }, { ...truth.lines[0], amountMinor: 501 }, { ...truth.lines[1], lineNo: 3, amountMinor: 1100 }] };
    const s = scoreReceipt(truth, labels, pred, [cls(1), cls(2), cls(3, { needQty: 1 })]);
    expect(s.ruleLinesFunded).toBe(1);
  });
  it("still scores a correctly rejected rule line as found", () => {
    const truth = receipt({ lines: [{ ...line(1, 1198), rawText: "beer" }], totalMinor: 1198 });
    const labels = [cls(1, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol" })];
    const s = scoreReceipt(truth, labels, truth, labels);
    expect(s.ruleLines).toEqual({ num: 1, den: 1 });
    expect(s.ruleLinesFunded).toBe(0);
  });
});
