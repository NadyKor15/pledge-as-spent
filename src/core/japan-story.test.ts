import { beforeAll, describe, expect, it } from "vitest";
import { rejectLine } from "./allocate";
import type { CaptureCommand, LineFunded } from "./events";
import { feeSavings } from "./fees";
import { replay } from "./ledger";
import { minorRate } from "./money";
import {
  captureSubmittedEvent,
  payoutSubmittedEvent,
  planCaptures,
  planClose,
  planHoldMaintenance,
  planPayout,
} from "./plan";
import {
  STORY_RECEIPT_ID,
  STORY_RECEIPT_TOTAL,
  STORY_T0,
  storyDrive,
  storyFundableLines,
  storyNeeds,
  storyPledges,
  storyRejectedLines,
} from "./fixtures/japan-story";
import { Book, daysAfter, hoursAfter } from "./testing/builders";
import { closeReport, donorStatement, ledgerRows, matchProgress, needProgress, pledgeBalance } from "./views";

// Expected numbers, worked by hand (base JPY; 1 euro cent = 1.6235 yen, 1 US cent = 1.512 yen):
// water    L1 432 -> match 216, Anna 216 = 133.05 cents -> 133; L2 472 -> 236 / 236 = 145.37 -> 145;
//          L3 396 -> 198 / 198 = 121.96 -> 122.                          Anna EUR 4.00
// diapers  L4 3278 -> 1639 / 1639 = 1083.99 cents -> 1084; L5 1958 -> 979 / 979 = 647.49 -> 647.  Mike USD 17.31
// batteries 792, 748, 1628, 220 -> halves 396 + 374 + 814 + 110 = 1694.  Yuki JPY 1,694
// match    650 + 2618 + 1694 = 4962.  Funded 9,924 = the 9 eligible lines.  Refused 436 + 3000.
const EXPECTED_SHARES: Record<number, { donor: string; base: number; quote: number }> = {
  1: { donor: "p-anna", base: 216, quote: 133 },
  2: { donor: "p-anna", base: 236, quote: 145 },
  3: { donor: "p-anna", base: 198, quote: 122 },
  4: { donor: "p-mike", base: 1639, quote: 1084 },
  5: { donor: "p-mike", base: 979, quote: 647 },
  6: { donor: "p-yuki", base: 396, quote: 396 },
  7: { donor: "p-yuki", base: 374, quote: 374 },
  8: { donor: "p-yuki", base: 814, quote: 814 },
  10: { donor: "p-yuki", base: 110, quote: 110 },
};

describe("Japanese story: one receipt, three donors, three currencies, a 1:1 company match", () => {
  const book = new Book(storyDrive, storyNeeds, STORY_T0);
  const funded: LineFunded[] = [];
  const captures: CaptureCommand[] = [];

  beforeAll(() => {
    for (const p of storyPledges) {
      book.apply({ id: `create-${p.id}`, at: STORY_T0, driveId: storyDrive.id, type: "PledgeCreated", pledge: p });
      // Yuki paid with a card; everyone else approved with a PayPal account.
      book.authorize(p.id, hoursAfter(1, STORY_T0), p.id === "p-yuki" ? "card" : "paypal");
    }
    const receiptAt = daysAfter(1, STORY_T0);
    for (const l of storyFundableLines) {
      const ev = book.fund(l, receiptAt);
      expect(ev?.type).toBe("LineFunded");
      funded.push(ev as LineFunded);
    }
    for (const r of storyRejectedLines) book.apply(rejectLine(book.state, r, receiptAt)!);
  });

  it("splits every eligible line half donor, half match, exact to the yen", () => {
    for (const ev of funded) {
      const want = EXPECTED_SHARES[ev.line.lineNo];
      const donor = ev.shares.find((s) => s.kind === "donor")!;
      const match = ev.shares.find((s) => s.kind === "match")!;
      expect(ev.unfundedBase).toBe(0);
      expect(ev.rejectedBase).toBe(0);
      expect(donor.pledgeId).toBe(want.donor);
      expect(donor.base).toBe(want.base);
      expect(donor.quote.minor).toBe(want.quote);
      expect(match.base).toBe(ev.line.amountBase - want.base);
      expect(donor.matchBase).toBe(match.base); // "your share unlocked this much of the match"
      expect(donor.base + match.base).toBe(ev.line.amountBase);
    }
  });

  it("keeps each conversion within one minor unit of the donor's currency", () => {
    for (const ev of funded) {
      for (const sh of ev.shares) {
        const k = minorRate(storyPledges.find((p) => p.id === sh.pledgeId)!.fx);
        const diff = BigInt(sh.quote.minor) * k.num - BigInt(sh.base) * k.den;
        expect((diff < 0n ? -diff : diff) <= k.num).toBe(true);
      }
    }
  });

  it("accounts for every yen of the receipt", () => {
    const rows = ledgerRows(book.state);
    expect(rows).toHaveLength(20); // 9 donor shares + 9 match shares + 2 refused lines
    expect(rows.reduce((a, r) => a + r.base, 0)).toBe(STORY_RECEIPT_TOTAL);
    expect(rows.filter((r) => r.kind === "rejected").map((r) => [r.lineNo, r.code, r.base])).toEqual([
      [9, "alcohol", 436],
      [11, "gift_card", 3000],
    ]);
    expect(matchProgress(book.state).usedBase).toBe(4962);
    expect(funded.reduce((a, e) => a + e.fundedBase, 0)).toBe(9924);
    expect(needProgress(book.state, "water")).toMatchObject({ qtyCovered: 12, remainingQty: 28, fundedBase: 1300 });
    expect(needProgress(book.state, "diapers")).toMatchObject({ qtyCovered: 3, fundedBase: 5236 });
    expect(needProgress(book.state, "batteries")).toMatchObject({ qtyCovered: 38, fundedBase: 3388 });
  });

  it("pays the volunteer the funded total in yen right away, once", () => {
    const cmd = planPayout(book.state, STORY_RECEIPT_ID)!;
    expect(cmd).toMatchObject({
      senderBatchId: "pay:kitasora-flood:rcpt-kitasora-0001",
      amount: { currency: "JPY", minor: 9924 },
      retry: false,
    });
    book.apply(payoutSubmittedEvent(cmd, daysAfter(1, STORY_T0)));
    expect(planPayout(book.state, STORY_RECEIPT_ID)).toMatchObject({ senderBatchId: cmd.senderBatchId, retry: true });
    book.event("PayoutConfirmed", hoursAfter(25, STORY_T0), {
      receiptId: STORY_RECEIPT_ID,
      senderBatchId: cmd.senderBatchId,
      payoutBatchId: "PAYOUT-BATCH-1",
      fee: { currency: "JPY", minor: 30 },
    });
    expect(planPayout(book.state, STORY_RECEIPT_ID)).toBeNull();
  });

  it("captures nothing before the shares are a day old, then one batch per hold", () => {
    expect(planCaptures(book.state, hoursAfter(30, STORY_T0))).toEqual([]);
    const cmds = planCaptures(book.state, hoursAfter(49, STORY_T0));
    expect(cmds.map((c) => [c.requestId, c.amount.currency, c.amount.minor, c.shareIds.length, c.reasons])).toEqual([
      ["cap:kitasora-flood:p-anna:1", "EUR", 400, 3, ["age"]],
      ["cap:kitasora-flood:p-mike:1", "USD", 1731, 2, ["age"]],
      ["cap:kitasora-flood:p-yuki:1", "JPY", 1694, 4, ["age"]],
      ["cap:kitasora-flood:p-match:1", "JPY", 4962, 9, ["age"]],
    ]);
    for (const c of cmds) {
      book.apply(captureSubmittedEvent(c, hoursAfter(49, STORY_T0)));
      captures.push(c);
    }
    expect(pledgeBalance(book.state, "p-anna")).toMatchObject({ accrued: 0, capturePending: 400, captured: 0 });
    // USD fee as PayPal reports it: 3.49% x 17.31 + 0.49 = 1.09
    for (const c of captures) {
      book.confirm(c, hoursAfter(49.05, STORY_T0), `CAP-${c.pledgeId}`, c.pledgeId === "p-mike" ? { currency: "USD", minor: 109 } : undefined);
    }
    expect(pledgeBalance(book.state, "p-anna")).toMatchObject({ status: "partially_captured", captured: 400, available: 1600 });
  });

  it("shows what batching saved", () => {
    const rows = Object.fromEntries(feeSavings(book.state).map((r) => [r.currency, r]));
    expect(rows.EUR).toMatchObject({ batches: 1, shares: 3, savedMinor: 78, estimate: false });
    expect(rows.USD).toMatchObject({ batches: 1, shares: 2, savedMinor: 49, estimate: false, paypalFeeMinor: 109 });
    expect(rows.JPY).toMatchObject({ batches: 2, shares: 13, savedMinor: (3 + 8) * 49, estimate: false });
  });

  it("gives Anna her statement in euros with the match her money unlocked", () => {
    const st = donorStatement(book.state, "p-anna");
    expect(st.rows.map((r) => [r.lineNo, r.item, r.qty, r.shareBase, r.share.minor, r.matchBase, r.captureId, r.status])).toEqual([
      [1, "Drinking water 2 L", 4, 216, 133, 216, "CAP-p-anna", "captured"],
      [2, "Drinking water 2 L", 4, 236, 145, 236, "CAP-p-anna", "captured"],
      [3, "Drinking water 2 L", 4, 198, 122, 198, "CAP-p-anna", "captured"],
    ]);
    expect(st.totals).toEqual({ shareBase: 650, share: 400, charged: 400, uncollected: 0, reversed: 0, matchBase: 650, helpBase: 1300 });
  });

  it("reauthorizes PayPal-account holds on day 4 but not the card hold", () => {
    expect(planHoldMaintenance(book.state, daysAfter(3.5, STORY_T0))).toEqual([]);
    const cmds = planHoldMaintenance(book.state, daysAfter(5, STORY_T0));
    expect(cmds.map((c) => [c.kind, c.pledgeId])).toEqual([
      ["reauthorize", "p-anna"],
      ["reauthorize", "p-mike"],
      ["reauthorize", "p-match"],
    ]);
    for (const c of cmds) {
      if (c.kind !== "reauthorize") continue;
      // PayPal may answer with a new authorization id; later commands must use it.
      book.event("Reauthorized", daysAfter(5, STORY_T0), {
        pledgeId: c.pledgeId,
        requestId: c.requestId,
        authorizationId: `${c.authorizationId}-R1`,
      });
    }
    expect(planHoldMaintenance(book.state, daysAfter(6, STORY_T0))).toEqual([]);
  });

  it("closes: nothing accrued, so every hold is voided on its newest authorization, then the drive closes", () => {
    book.event("DriveClosing", daysAfter(7, STORY_T0), {});
    const cmds = planClose(book.state, daysAfter(7, STORY_T0));
    expect(cmds.map((c) => (c.kind === "void" ? [c.kind, c.pledgeId, c.authorizationId, c.requestId] : [c.kind]))).toEqual([
      ["void", "p-anna", "AUTH-p-anna-R1", "void:kitasora-flood:p-anna"],
      ["void", "p-mike", "AUTH-p-mike-R1", "void:kitasora-flood:p-mike"],
      ["void", "p-yuki", "AUTH-p-yuki", "void:kitasora-flood:p-yuki"],
      ["void", "p-match", "AUTH-p-match-R1", "void:kitasora-flood:p-match"],
    ]);
    for (const c of cmds) if (c.kind === "void") book.event("HoldVoided", daysAfter(7, STORY_T0), { pledgeId: c.pledgeId });
    expect(planClose(book.state, daysAfter(7, STORY_T0))).toEqual([{ kind: "close_drive", driveId: "kitasora-flood" }]);
    book.event("DriveClosed", daysAfter(7, STORY_T0), {});
    expect(book.state.drive?.status).toBe("closed");
  });

  it("reports pledged / spent / released per donor, each adding up exactly", () => {
    expect(closeReport(book.state).map((r) => [r.pledgeId, r.currency, r.pledged, r.spent, r.released, r.settled])).toEqual([
      ["p-anna", "EUR", 2000, 400, 1600, true],
      ["p-mike", "USD", 3000, 1731, 1269, true],
      ["p-yuki", "JPY", 3000, 1694, 1306, true],
      ["p-match", "JPY", 500_000, 4962, 495_038, true],
    ]);
  });

  it("rebuilds the same book from its journal, and a second replay of the journal changes nothing", () => {
    const rebuilt = replay(book.events);
    expect(rebuilt).toEqual(book.state);
    expect(replay(book.events, rebuilt)).toBe(rebuilt);
  });
});
