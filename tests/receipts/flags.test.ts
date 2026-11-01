import { describe, expect, it } from "vitest";
import { checkReceipt, type KnownReceipt } from "../../src/receipts/checks";
import { cls, drive, receipt } from "./fixtures";

const codes = (r = receipt(), extra: Partial<Parameters<typeof checkReceipt>[0]> = {}) =>
  checkReceipt({ receipt: r, drive, ...extra }).map((f) => f.code);

describe("checkReceipt", () => {
  it("passes a clean receipt", () => {
    expect(codes()).toEqual([]);
  });

  it("finds the zone in an address read without its accents or dotless i, and no further", () => {
    const d = { ...drive, zone: ["Yıldızova", "Villa Alborada"] };
    expect(codes(receipt({ merchantAddress: "Sanayi Sk. No:7, Yildizova" }), { drive: d })).not.toContain("out_of_zone");
    expect(codes(receipt({ merchantAddress: "Plaza 3, VILLA ALBORADÁ" }), { drive: d })).not.toContain("out_of_zone");
    expect(codes(receipt({ merchantAddress: "Liman Cd. 1, Denizbahçe" }), { drive: d })).toContain("out_of_zone");
  });

  it("blocks an unreadable photo and asks for a retake", () => {
    const flags = checkReceipt({ receipt: receipt({ readability: "unreadable" }), drive });
    expect(flags[0]).toMatchObject({ code: "unreadable", severity: "block" });
    expect(flags[0].messageEn).toMatch(/retake/i);
    // No point reconciling lines that could not be read.
    expect(flags.map((f) => f.code)).not.toContain("total_mismatch");
  });

  it("sends a poor photo to review", () => {
    expect(checkReceipt({ receipt: receipt({ readability: "poor" }), drive })[0]).toMatchObject({ code: "poor_quality", severity: "review" });
  });

  it("flags totals that do not add up", () => {
    expect(codes(receipt({ totalMinor: 1 }))).toEqual(["total_mismatch"]);
  });

  it("flags a purchase before the disaster, not on the day itself", () => {
    expect(codes(receipt({ purchasedAt: "2026-11-01T23:59:00" }))).toEqual(["pre_disaster"]);
    expect(codes(receipt({ purchasedAt: "2026-11-02T00:00:00" }))).toEqual([]);
  });

  it("asks for a review when the date is missing or not a date", () => {
    expect(codes(receipt({ purchasedAt: null }))).toEqual(["date_unknown"]);
    expect(codes(receipt({ purchasedAt: "yesterday" }))).toEqual(["date_unknown"]);
  });

  it("flags a store outside the zone, ignoring case and character width", () => {
    expect(codes(receipt({ merchantAddress: "9 Elm Rd, Otherville" }))).toEqual(["out_of_zone"]);
    expect(codes(receipt({ merchantAddress: "9 Elm Rd, KITASORA" }))).toEqual([]);
    expect(codes(receipt({ merchantAddress: "空川県北空市中央1-2" }))).toEqual([]);
    expect(codes(receipt({ merchantAddress: "ｷﾀｿﾗ駅前, 北空" }))).toEqual([]);
    expect(codes(receipt({ merchantAddress: "ＫＩＴＡＳＯＲＡ" }))).toEqual([]);
  });

  it("asks for a review when there is no address", () => {
    expect(codes(receipt({ merchantAddress: null }))).toEqual(["zone_unknown"]);
  });

  it("blocks a duplicate and names the first upload", () => {
    const known: KnownReceipt[] = [{ receiptId: "r-7", uploadedAt: "2026-11-05T10:00:00Z", sha256: "a", dHash: null, semanticKey: "k" }];
    const flags = checkReceipt({ receipt: receipt(), drive, fingerprint: { sha256: "a", dHash: null, semanticKey: null }, known });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ code: "duplicate", severity: "block" });
    expect(flags[0].messageEn).toContain("2026-11-05T10:00:00Z");
    expect(checkReceipt({ receipt: receipt(), drive, fingerprint: { sha256: "b", dHash: null, semanticKey: null }, known })).toEqual([]);
  });

  it("sends doubtful classifications to review", () => {
    expect(codes(receipt(), { classifications: [cls(1), cls(2, { confidence: 0.5 })] })).toEqual(["low_confidence"]);
    expect(codes(receipt(), { classifications: [cls(1, { verdict: "review", ruleCode: "unclear" })] })).toEqual(["low_confidence"]);
    expect(codes(receipt(), { classifications: [cls(1, { confidence: 0.7 })] })).toEqual([]);
    expect(codes(receipt(), { classifications: [cls(1, { confidence: 0.8 })], minConfidence: 0.9 })).toEqual(["low_confidence"]);
  });

  it("reports several problems at once", () => {
    const r = receipt({ purchasedAt: "2026-10-01T10:00:00", merchantAddress: "Elsewhere" });
    expect(codes(r)).toEqual(["pre_disaster", "out_of_zone"]);
  });
});
