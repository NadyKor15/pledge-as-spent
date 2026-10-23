import { describe, expect, it } from "vitest";
import type { CaptureCommand } from "./events";
import * as core from "./index";
import { unsettledHolds } from "./ledger";
import { payoutSubmittedEvent, planCaptures, planClose, planHoldMaintenance, planPayout } from "./plan";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, makePledge, T0 } from "./testing/builders";
import { closeReport, donorStatement, ledgerRows, pledgeBalance } from "./views";

// Acceptance panel wf_fb122b60-b73, lens core-money: K1-K3 confirmed, K4-K6 to verify.

const yen = (minor: number) => ({ currency: "JPY" as const, minor });
const book = () => new Book(makeDrive(), [makeNeed("water", 1000)]);

function accruedHold(amount = 1000) {
  const b = book().pledge({ id: "p1", needId: "water", amount: yen(10_000) });
  b.fund(line("r1", 1, "water", 1, amount), hoursAfter(1));
  return b;
}

const refuse = (b: Book, cmd: CaptureCommand, at: string, reason: string) => b.submit(cmd, at).failCapture(cmd, at, reason);

describe("K1: a hold authorized after the drive closed is voided", () => {
  function lateAuthorized(closeFully: boolean) {
    const b = book();
    b.apply({ id: "pc", at: T0, driveId: "drv1", type: "PledgeCreated", pledge: makePledge({ id: "late", needId: "water", amount: yen(3000) }) });
    b.event("DriveClosing", daysAfter(1), {});
    if (closeFully) b.event("DriveClosed", daysAfter(1), {});
    b.authorize("late", daysAfter(2));
    return b;
  }

  it("on a closed drive: planClose and planHoldMaintenance both plan the void, then the hold is settled", () => {
    const b = lateAuthorized(true);
    expect(unsettledHolds(b.state)).toEqual(["late"]);
    const want = [{ kind: "void", driveId: "drv1", pledgeId: "late", authorizationId: "AUTH-late", requestId: "void:drv1:late", reason: "close" }];
    expect(planClose(b.state, daysAfter(2))).toEqual(want);
    expect(planHoldMaintenance(b.state, daysAfter(2))).toEqual(want);
    b.event("HoldVoided", daysAfter(2), { pledgeId: "late" });
    expect(unsettledHolds(b.state)).toEqual([]);
    expect(planClose(b.state, daysAfter(3))).toEqual([]);
    expect(closeReport(b.state)[0]).toMatchObject({ pledged: 3000, spent: 0, released: 3000, settled: true });
  });

  it("on a closing drive: planHoldMaintenance plans it too, and DriveClosed waits for it", () => {
    const b = lateAuthorized(false);
    expect(planHoldMaintenance(b.state, daysAfter(2)).map((c) => c.kind)).toEqual(["void"]);
    expect(() => b.event("DriveClosed", daysAfter(2), {})).toThrow(/not settled: late/);
  });
});

describe("K2: a capture refused for good stops being retried", () => {
  it("classifies PayPal refusals: terminal issues, retryable outages, unknown = retryable but bounded", () => {
    const c = core.classifyCaptureFailure;
    for (const r of [
      "422 UNPROCESSABLE_ENTITY AUTHORIZATION_VOIDED (debug_id abc)",
      "422 UNPROCESSABLE_ENTITY AUTHORIZATION_EXPIRED",
      "422 UNPROCESSABLE_ENTITY AUTHORIZATION_ALREADY_CAPTURED",
      "422 UNPROCESSABLE_ENTITY PAYER_ACCOUNT_RESTRICTED",
      "422 UNPROCESSABLE_ENTITY INSTRUMENT_DECLINED",
      "422 UNPROCESSABLE_ENTITY MAX_CAPTURE_COUNT_EXCEEDED",
    ]) {
      expect(c(r), r).toMatchObject({ terminal: true });
    }
    expect(c("422 UNPROCESSABLE_ENTITY INSTRUMENT_DECLINED").code).toBe("INSTRUMENT_DECLINED");
    for (const r of ["500 INTERNAL_SERVER_ERROR", "503 Service Unavailable", "timeout", "429 RATE_LIMIT_REACHED", "capture 1AB DECLINED"]) {
      expect(c(r), r).toMatchObject({ terminal: false });
    }
  });

  it("a terminal refusal moves the shares to uncollected with the reason, blocks the hold, and lets it be voided", () => {
    const b = accruedHold();
    const [cmd] = planCaptures(b.state, hoursAfter(26));
    expect(cmd.shareIds).toEqual(["r1:1@p1"]);
    b.submit(cmd, hoursAfter(26));
    // accrued while the batch was in flight
    b.fund(line("r1", 2, "water", 1, 200), hoursAfter(26.5));
    b.fund(line("r1", 3, "water", 1, 300), hoursAfter(27));
    b.failCapture(cmd, hoursAfter(28), "422 UNPROCESSABLE_ENTITY INSTRUMENT_DECLINED");
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ accrued: 0, capturePending: 0, uncollected: 1500, available: 0, blocked: true, blockedReason: "INSTRUMENT_DECLINED" });
    expect(planCaptures(b.state, daysAfter(5), { force: true })).toEqual([]);
    expect(planHoldMaintenance(b.state, hoursAfter(29))).toEqual([
      { kind: "void", driveId: "drv1", pledgeId: "p1", authorizationId: "AUTH-p1", requestId: "void:drv1:p1", reason: "capture_refused" },
    ]);
    // new lines no longer draw on it
    expect((b.fund(line("r2", 1, "water", 1, 100), hoursAfter(29)) as { fundedBase: number }).fundedBase).toBe(0);
    const rows = donorStatement(b.state, "p1").rows;
    expect(rows.map((r) => [r.lineNo, r.status, r.uncollectedReason])).toEqual([
      [1, "uncollected", "INSTRUMENT_DECLINED"],
      [2, "uncollected", "INSTRUMENT_DECLINED"],
      [3, "uncollected", "INSTRUMENT_DECLINED"],
    ]);
    b.event("HoldVoided", hoursAfter(29), { pledgeId: "p1" });
    expect(closeReport(b.state)[0]).toMatchObject({ pledged: 10_000, spent: 0, uncollected: 1500, released: 8500, settled: true });
  });

  it("retryable refusals back off in time and give up after a bounded number of attempts", () => {
    const b = accruedHold();
    b.event("DriveClosing", hoursAfter(2), {});
    const tries: string[] = [];
    let t = hoursAfter(2);
    for (let i = 0; i < 10; i++) {
      const caps = planClose(b.state, t).filter((c): c is CaptureCommand => c.kind === "capture");
      if (caps.length) {
        tries.push(`${caps[0].requestId}@${(Date.parse(t) - Date.parse(hoursAfter(2))) / 60_000}m`);
        refuse(b, caps[0], t, "500 INTERNAL_SERVER_ERROR");
      }
      t = core.addMs(t, 5 * 60_000);
    }
    // 5-minute ticks; waits of 15, 30 minutes between tries; the 3rd refusal gives up
    expect(tries).toEqual(["cap:drv1:p1:1@0m", "cap:drv1:p1:2@15m", "cap:drv1:p1:3@45m"]);
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ accrued: 0, uncollected: 1000, blocked: true });
    expect(b.state.holds.p1.batches.map((x) => [x.seq, x.status, x.terminal ?? false])).toEqual([
      [1, "failed", false],
      [2, "failed", false],
      [3, "failed", true],
    ]);
    const voids = planClose(b.state, t);
    expect(voids.map((c) => c.kind)).toEqual(["void"]);
    b.event("HoldVoided", t, { pledgeId: "p1" });
    expect(planClose(b.state, t)).toEqual([{ kind: "close_drive", driveId: "drv1" }]);
  });

  it("the coordinator's force button skips the wait but not the bound", () => {
    const b = accruedHold();
    const [c1] = planCaptures(b.state, hoursAfter(26)); // the share is old enough to go
    refuse(b, c1, hoursAfter(26), "503 SERVICE_UNAVAILABLE");
    expect(planCaptures(b.state, hoursAfter(26.01))).toEqual([]); // waiting out the backoff
    const [c2] = planCaptures(b.state, hoursAfter(26.01), { force: true });
    expect(c2.requestId).toBe("cap:drv1:p1:2");
    refuse(b, c2, hoursAfter(26.02), "503 SERVICE_UNAVAILABLE");
    const [c3] = planCaptures(b.state, hoursAfter(26.03), { force: true });
    refuse(b, c3, hoursAfter(26.03), "503 SERVICE_UNAVAILABLE");
    expect(planCaptures(b.state, hoursAfter(27), { force: true })).toEqual([]); // attempts used up
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ uncollected: 1000, blocked: true });
  });

  it("an explicit terminal flag on the event wins over the text", () => {
    const b = accruedHold();
    const [c1] = planCaptures(b.state, hoursAfter(2), { force: true });
    b.submit(c1, hoursAfter(2)).apply({ id: "cf-x", at: hoursAfter(2), driveId: "drv1", type: "CaptureFailed", pledgeId: "p1", requestId: c1.requestId, reason: "capture 9 DECLINED", terminal: true });
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ uncollected: 1000, blocked: true, blockedReason: "capture 9 DECLINED" });
  });
});

describe("K3: a confirmed capture can be reversed", () => {
  function captured() {
    const b = book().pledge({ id: "p1", needId: "water", amount: yen(5000) });
    b.fund(line("r1", 1, "water", 1, 600), hoursAfter(1));
    b.fund(line("r1", 2, "water", 1, 400), hoursAfter(1));
    const [cmd] = planCaptures(b.state, hoursAfter(2), { force: true });
    b.submit(cmd, hoursAfter(2)).confirm(cmd, hoursAfter(3), "CAP-1");
    return { b, cmd };
  }

  it("finds the batch by capture id, moves the money to reversed and flags the shares", () => {
    const { b } = captured();
    const ev = core.captureReversedEvent(b.state, { captureId: "CAP-1", amount: yen(1000), reason: "PAYMENT.CAPTURE.REVERSED", at: hoursAfter(40) })!;
    expect(ev).toMatchObject({ type: "CaptureReversed", pledgeId: "p1", requestId: "cap:drv1:p1:1", captureId: "CAP-1", amount: yen(1000) });
    b.apply(ev);
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ captured: 0, reversed: 1000, available: 4000 - 0 });
    expect(donorStatement(b.state, "p1").rows.map((r) => [r.lineNo, r.status, r.reversed])).toEqual([
      [1, "reversed", 600],
      [2, "reversed", 400],
    ]);
    expect(donorStatement(b.state, "p1").totals).toMatchObject({ share: 1000, charged: 0, reversed: 1000, uncollected: 0 });
    expect(ledgerRows(b.state).map((r) => r.status)).toEqual(["reversed", "reversed"]);
    const s = b.state;
    b.apply(ev); // the same webhook again
    expect(b.state).toBe(s);
    expect(core.captureReversedEvent(b.state, { captureId: "CAP-404", amount: yen(1), reason: "x", at: hoursAfter(41) })).toBeNull();
  });

  it("allows partial reversals up to the captured amount, split over the shares", () => {
    const { b } = captured();
    b.apply(core.captureReversedEvent(b.state, { captureId: "CAP-1", amount: yen(250), reason: "PAYMENT.CAPTURE.REFUNDED", at: hoursAfter(40), reversalId: "REF-1" })!);
    expect(pledgeBalance(b.state, "p1")).toMatchObject({ captured: 750, reversed: 250 });
    expect(donorStatement(b.state, "p1").rows.map((r) => [r.status, r.reversed])).toEqual([
      ["partly_reversed", 150],
      ["partly_reversed", 100],
    ]);
    // the same refund reported under another event id is not counted twice
    const again = core.captureReversedEvent(b.state, { captureId: "CAP-1", amount: yen(250), reason: "lookup", at: hoursAfter(41), reversalId: "REF-1" })!;
    const s = b.state;
    b.apply(again);
    expect(b.state).toBe(s);
    expect(() => b.apply(core.captureReversedEvent(b.state, { captureId: "CAP-1", amount: yen(751), reason: "x", at: hoursAfter(42) })!)).toThrow(/more than was captured/);
  });

  it("is refused on a batch that is not confirmed", () => {
    const b = accruedHold();
    const [cmd] = planCaptures(b.state, hoursAfter(2), { force: true });
    b.submit(cmd, hoursAfter(2));
    expect(() => b.event("CaptureReversed", hoursAfter(3), { pledgeId: "p1", requestId: cmd.requestId, captureId: "X", amount: yen(10), reason: "x" })).toThrow(/not confirmed/);
  });

  it("a fully captured hold that was reversed still closes: pledged = spent + released + uncollected + reversed", () => {
    const b = book().pledge({ id: "p1", needId: "water", amount: yen(1000) });
    b.fund(line("r1", 1, "water", 1, 1000), hoursAfter(1));
    const [cmd] = planCaptures(b.state, hoursAfter(2), { force: true });
    b.submit(cmd, hoursAfter(2)).confirm(cmd, hoursAfter(3), "CAP-9");
    b.apply(core.captureReversedEvent(b.state, { captureId: "CAP-9", amount: yen(400), reason: "chargeback", at: hoursAfter(9) })!);
    expect(b.state.pledges.p1.status).toBe("captured");
    b.event("DriveClosing", hoursAfter(10), {});
    expect(planClose(b.state, hoursAfter(10))).toEqual([{ kind: "close_drive", driveId: "drv1" }]);
    expect(closeReport(b.state)[0]).toMatchObject({ pledged: 1000, spent: 600, reversed: 400, released: 0, settled: true });
  });
});

describe("K4: lines funded after a confirmed payout are paid as a top-up", () => {
  it("pays the difference under the next sender_batch_id", () => {
    const b = accruedHold(1000);
    const first = planPayout(b.state, "r1")!;
    b.apply(payoutSubmittedEvent(first, hoursAfter(2)));
    b.event("PayoutConfirmed", hoursAfter(3), { receiptId: "r1", senderBatchId: first.senderBatchId, payoutBatchId: "PB1" });
    b.fund(line("r1", 2, "water", 1, 500), hoursAfter(4)); // e.g. a flagged line the coordinator approved later
    const topUp = planPayout(b.state, "r1")!;
    expect(topUp).toMatchObject({ senderBatchId: "pay:drv1:r1:2", amount: yen(500), attempt: 2, retry: false });
    b.apply(payoutSubmittedEvent(topUp, hoursAfter(4)));
    b.event("PayoutConfirmed", hoursAfter(5), { receiptId: "r1", senderBatchId: topUp.senderBatchId, payoutBatchId: "PB2" });
    expect(planPayout(b.state, "r1")).toBeNull();
  });
});

describe("K5: uncollected money is not hidden inside released", () => {
  it("closeReport and the statement show it separately", () => {
    const b = accruedHold(1000);
    b.event("HoldExpired", daysAfter(29), { pledgeId: "p1" });
    expect(closeReport(b.state)[0]).toMatchObject({ pledged: 10_000, spent: 0, released: 9000, uncollected: 1000, reversed: 0, settled: true });
    expect(donorStatement(b.state, "p1").totals).toMatchObject({ share: 1000, charged: 0, uncollected: 1000 });
    expect(donorStatement(b.state, "p1").rows[0]).toMatchObject({ status: "uncollected", uncollectedReason: "hold expired" });
  });
});

describe("K6: shares funded outside the honor period are flagged", () => {
  it("marks each share honored or not; card holds stay fundable until day 29", () => {
    const b = book().pledge({ id: "card", needId: "water", amount: yen(10_000) }, T0, "card");
    const inside = b.fund(line("r1", 1, "water", 1, 100), daysAfter(2)) as { shares: { honored?: boolean }[] };
    const outside = b.fund(line("r1", 2, "water", 1, 100), daysAfter(10)) as { shares: { honored?: boolean }[] };
    expect(inside.shares[0].honored).toBe(true);
    expect(outside.shares[0].honored).toBe(false);
    expect(donorStatement(b.state, "card").rows.map((r) => r.honored)).toEqual([true, false]);
  });
});
