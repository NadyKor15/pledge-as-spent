import { describe, expect, it } from "vitest";
import { FIXED_FEES, feeSavings } from "./fees";
import { planCaptures } from "./plan";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed } from "./testing/builders";
import { closeReport, donorStatement, ledgerRows, matchProgress, needProgress, pledgeBalance } from "./views";

const NOW = hoursAfter(1);

function setup() {
  const b = new Book(makeDrive(), [makeNeed("water", 10, { label: "Water 2 L", unit: "bottle" })])
    .pledge({ id: "anna", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35" })
    .pledge({ id: "match", kind: "match", amount: { currency: "JPY", minor: 1000 } });
  return b;
}

describe("pledgeBalance", () => {
  it("shows the hold's buckets in the donor's currency", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    expect(pledgeBalance(b.state, "anna")).toEqual({
      pledgeId: "anna",
      kind: "donor",
      donorName: "Donor anna",
      needId: "water",
      status: "authorized",
      revoked: false,
      currency: "EUR",
      pledged: 2000,
      authorized: 2000,
      captured: 0,
      capturePending: 0,
      accrued: 133,
      released: 0,
      uncollected: 0,
      available: 1867,
      capacityBase: 3031,
      authorizationId: "AUTH-anna",
      expiresAt: daysAfter(29),
    });
    expect(() => pledgeBalance(b.state, "nobody")).toThrow(/unknown_pledge/);
  });
});

describe("donorStatement", () => {
  it("follows each share from accrued to captured, with the capture id", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    expect(donorStatement(b.state, "anna").rows[0]).toEqual({
      receiptId: "r1",
      lineNo: 1,
      needId: "water",
      item: "Water 2 L",
      unit: "bottle",
      qty: 2,
      shareBase: 216,
      share: { currency: "EUR", minor: 133 },
      matchBase: 216,
      captureId: null,
      requestId: null,
      status: "accrued",
      at: NOW,
    });
    const [cmd] = planCaptures(b.state, NOW, { force: true });
    b.submit(cmd, NOW);
    expect(donorStatement(b.state, "anna").rows[0]).toMatchObject({ status: "capture_pending", requestId: "cap:drv1:anna:1", captureId: null });
    b.confirm(cmd, NOW, "CAP-77");
    expect(donorStatement(b.state, "anna").rows[0]).toMatchObject({ status: "captured", captureId: "CAP-77" });
  });

  it("marks shares the hold could not collect, and shares too small to charge", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    b.event("HoldExpired", NOW, { pledgeId: "anna" });
    expect(donorStatement(b.state, "anna").rows[0].status).toBe("uncollected");

    const g = new Book(makeDrive(), [makeNeed("water", 10)]).pledge({ id: "gbp", needId: "water", amount: { currency: "GBP", minor: 100 }, rate: "250" });
    g.fund(line("r1", 1, "water", 1, 1), NOW);
    expect(donorStatement(g.state, "gbp").rows[0]).toMatchObject({ status: "nothing_to_capture", shareBase: 1, share: { minor: 0 } });
  });

  it("totals what the donor paid and the help it unlocked", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    b.fund(line("r1", 2, "water", 2, 472), NOW);
    expect(donorStatement(b.state, "anna").totals).toEqual({ shareBase: 452, share: 278, matchBase: 452, helpBase: 904 });
  });
});

describe("ledgerRows", () => {
  it("one row per share plus the refused and unfunded parts; rows add up to each line", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 4, { label: "Water" })]).pledge({ id: "d", needId: "water", amount: { currency: "JPY", minor: 300 } });
    b.fund(line("r1", 1, "water", 6, 600), NOW); // 4 of 6 accepted: 400 fundable, 200 refused; donor has 300
    b.apply({ id: "rej", at: NOW, driveId: "drv1", type: "LineRejected", receiptId: "r1", lineNo: 2, needId: null, needQty: null, amountBase: 50, code: "alcohol", reasonEn: "Beer." });
    const rows = ledgerRows(b.state);
    expect(rows.map((r) => [r.rowId, r.kind, r.base, r.amount, r.status, r.code])).toEqual([
      ["r1:1/d", "donor_share", 300, 300, "accrued", null],
      ["r1:1/need_covered", "rejected", 200, null, "rejected", "need_covered"],
      ["r1:1/unfunded", "unfunded", 100, null, "unfunded", "not_enough_pledges"],
      ["r1:2/rejected", "rejected", 50, null, "rejected", "alcohol"],
    ]);
    expect(rows.reduce((a, r) => a + r.base, 0)).toBe(650);
    expect(rows[1].reasonEn).toBe("Water: only 4 of 6 were still needed.");
  });
});

describe("needProgress and matchProgress", () => {
  it("counts units, money and refusals per need", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 8, 800), NOW);
    b.fund(line("r1", 2, "water", 4, 400), NOW); // 2 of 4 accepted
    b.fund(line("r1", 3, "water", 1, 100), NOW); // need covered
    const p = needProgress(b.state, "water");
    expect(p).toMatchObject({ qtyNeeded: 10, qtyCovered: 10, remainingQty: 0, covered: true, fundedBase: 1000, rejectedBase: 300, unfundedBase: 0 });
    expect(p.donorBase + p.matchBase).toBe(p.fundedBase);
    expect(() => needProgress(b.state, "rice")).toThrow(/unknown_need/);
  });

  it("shows the match pledged, used and left", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    expect(matchProgress(b.state)).toMatchObject({ ratio: { num: 1, den: 1 }, pledgedBase: 1000, usedBase: 216, capacityBase: 784 });
  });
});

describe("feeSavings", () => {
  it("counts confirmed batches only: (shares - 1) x fixed fee", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 1, 100), NOW);
    b.fund(line("r1", 2, "water", 1, 100), NOW);
    b.fund(line("r1", 3, "water", 1, 100), NOW);
    const cmds = planCaptures(b.state, NOW, { force: true });
    for (const c of cmds) b.submit(c, NOW);
    expect(feeSavings(b.state)).toEqual([]);
    for (const c of cmds) b.confirm(c, NOW, undefined, c.amount.currency === "JPY" ? { currency: "JPY", minor: 50 } : undefined);
    expect(feeSavings(b.state)).toEqual([
      { currency: "EUR", batches: 1, shares: 3, savedMinor: 2 * FIXED_FEES.EUR.minor, estimate: true, source: FIXED_FEES.EUR.source, paypalFeeMinor: 0, batchesWithReportedFee: 0 },
      { currency: "JPY", batches: 1, shares: 3, savedMinor: 2 * FIXED_FEES.JPY.minor, estimate: true, source: FIXED_FEES.JPY.source, paypalFeeMinor: 50, batchesWithReportedFee: 1 },
    ]);
  });

  it("says so when the fee table has no entry", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 1, 100), NOW);
    for (const c of planCaptures(b.state, NOW, { force: true })) b.submit(c, NOW).confirm(c, NOW);
    const rows = feeSavings(b.state, { JPY: FIXED_FEES.JPY });
    expect(rows.find((r) => r.currency === "EUR")).toMatchObject({ savedMinor: null, estimate: true });
    expect(rows.find((r) => r.currency === "JPY")).toMatchObject({ savedMinor: 0 });
  });

  it("the USD fixed fee comes from a real sandbox capture; the rest are marked estimates", () => {
    expect(FIXED_FEES.USD).toMatchObject({ minor: 49, estimate: false });
    for (const [cur, fee] of Object.entries(FIXED_FEES)) if (cur !== "USD") expect(fee.estimate).toBe(true);
  });
});

describe("closeReport", () => {
  it("is unsettled while money is held and adds up after the void", () => {
    const b = setup();
    b.fund(line("r1", 1, "water", 2, 432), NOW);
    expect(closeReport(b.state).map((r) => r.settled)).toEqual([false, false]);
    for (const c of planCaptures(b.state, NOW, { force: true })) b.submit(c, NOW).confirm(c, NOW);
    b.event("HoldVoided", NOW, { pledgeId: "anna" }).event("HoldVoided", NOW, { pledgeId: "match" });
    expect(closeReport(b.state)).toEqual([
      { pledgeId: "anna", donorName: "Donor anna", kind: "donor", currency: "EUR", pledged: 2000, spent: 133, released: 1867, settled: true },
      { pledgeId: "match", donorName: "Donor match", kind: "match", currency: "JPY", pledged: 1000, spent: 216, released: 784, settled: true },
    ]);
  });
});
