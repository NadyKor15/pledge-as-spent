import { describe, expect, it } from "vitest";
import type { ReauthorizeCommand } from "./events";
import { applyEvent } from "./ledger";
import {
  holdExpiredEvent,
  planCaptures,
  planClose,
  planExplicitReauthorize,
  planHoldMaintenance,
  planPayout,
  renewalRequestedEvent,
} from "./plan";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, T0 } from "./testing/builders";
import type { PaymentSource } from "./types";

const yen = (minor: number) => ({ currency: "JPY" as const, minor });

function oneHold(opts: { source?: PaymentSource; threshold?: number; at?: string } = {}) {
  const drive = makeDrive({ batch: { maxAgeHours: 24, thresholdMinor: opts.threshold ? { JPY: opts.threshold } : {} } });
  return new Book(drive, [makeNeed("water", 1000)]).pledge({ id: "a", needId: "water", amount: yen(10_000) }, opts.at ?? T0, opts.source ?? "paypal");
}

describe("planCaptures (SPEC §4)", () => {
  it("waits until the oldest unsent share is maxAgeHours old", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    b.fund(line("r1", 2, "water", 1, 200), hoursAfter(20));
    expect(planCaptures(b.state, hoursAfter(24.99))).toEqual([]);
    expect(planCaptures(b.state, hoursAfter(25))).toEqual([
      {
        kind: "capture",
        driveId: "drv1",
        pledgeId: "a",
        authorizationId: "AUTH-a",
        amount: yen(500),
        finalCapture: false,
        requestId: "cap:drv1:a:1",
        seq: 1,
        shareIds: ["r1:1@a", "r1:2@a"],
        reasons: ["age"],
        retry: false,
      },
    ]);
  });

  it("captures as soon as the accrued amount reaches the currency threshold", () => {
    const b = oneHold({ threshold: 1000 });
    b.fund(line("r1", 1, "water", 1, 999), hoursAfter(1));
    expect(planCaptures(b.state, hoursAfter(1))).toEqual([]);
    b.fund(line("r1", 2, "water", 1, 1), hoursAfter(1));
    expect(planCaptures(b.state, hoursAfter(1)).map((c) => c.reasons)).toEqual([["threshold"]]);
  });

  it("captures when the hold has two days or less to live", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), daysAfter(26.9));
    expect(planCaptures(b.state, daysAfter(26.95))).toEqual([]);
    expect(planCaptures(b.state, daysAfter(27)).map((c) => c.reasons)).toEqual([["expiry"]]);
    expect(planCaptures(b.state, daysAfter(29))).toEqual([]); // past its life: no capture, maintenance expires it
  });

  it("captures on closing, on force, and on revocation", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    expect(planCaptures(b.state, hoursAfter(2), { force: true }).map((c) => c.reasons)).toEqual([["force"]]);
    b.event("PledgeRevoked", hoursAfter(2), { pledgeId: "a" });
    expect(planCaptures(b.state, hoursAfter(2)).map((c) => c.reasons)).toEqual([["revoked"]]);
    b.event("DriveClosing", hoursAfter(2), {});
    expect(planCaptures(b.state, hoursAfter(2)).map((c) => c.reasons)).toEqual([["closing", "revoked"]]);
  });

  it("keeps one capture in flight per hold and resends a stale one under the same id", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    const [cmd] = planCaptures(b.state, hoursAfter(30));
    b.submit(cmd, hoursAfter(30));
    b.fund(line("r1", 2, "water", 1, 100), hoursAfter(1));
    expect(planCaptures(b.state, hoursAfter(30.1), { force: true })).toEqual([]);
    const [again] = planCaptures(b.state, hoursAfter(30 + 10 / 60));
    expect(again).toMatchObject({ requestId: "cap:drv1:a:1", seq: 1, amount: yen(300), retry: true, shareIds: ["r1:1@a"] });
    expect(planCaptures(b.state, hoursAfter(30.05), { retryAfterMinutes: 1 })[0]).toMatchObject({ requestId: "cap:drv1:a:1", retry: true });
    expect(() => planCaptures(b.state, hoursAfter(31), { retryAfterMinutes: -1 })).toThrow(/retryAfterMinutes/);
  });

  it("after PayPal refuses a batch, the next one takes the next seq", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    const [first] = planCaptures(b.state, hoursAfter(30));
    b.submit(first, hoursAfter(30)).failCapture(first, hoursAfter(30.01));
    expect(planCaptures(b.state, hoursAfter(30.02))).toEqual([]); // 15 minutes of backoff first
    const [second] = planCaptures(b.state, hoursAfter(30.26));
    expect(second).toMatchObject({ requestId: "cap:drv1:a:2", seq: 2, amount: yen(300), reasons: ["age"], retry: false });
    b.submit(second, hoursAfter(30.26)).confirm(second, hoursAfter(30.27));
    b.fund(line("r1", 2, "water", 1, 50), hoursAfter(31));
    expect(planCaptures(b.state, hoursAfter(31), { force: true })[0]).toMatchObject({ requestId: "cap:drv1:a:3", seq: 3, amount: yen(50) });
  });

  it("sends captures to the newest authorization id", () => {
    const b = oneHold();
    b.event("Reauthorized", daysAfter(4), { pledgeId: "a", requestId: "reauth:drv1:a:1", authorizationId: "AUTH-NEW" });
    b.fund(line("r1", 1, "water", 1, 300), daysAfter(4));
    expect(planCaptures(b.state, daysAfter(4), { force: true })[0].authorizationId).toBe("AUTH-NEW");
  });

  it("ignores holds with nothing accrued, ended holds and pledges never authorized", () => {
    const b = oneHold();
    expect(planCaptures(b.state, daysAfter(2), { force: true })).toEqual([]);
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    b.event("HoldVoided", hoursAfter(2), { pledgeId: "a" });
    expect(planCaptures(b.state, daysAfter(2), { force: true })).toEqual([]);
  });
});

describe("planHoldMaintenance (SPEC §5)", () => {
  const kinds = (b: Book, at: string) => planHoldMaintenance(b.state, at).map((c) => c.kind);

  it("day 0 and day 3: nothing; day 4: reauthorize a PayPal-account hold once", () => {
    const b = oneHold();
    expect(kinds(b, T0)).toEqual([]);
    expect(kinds(b, daysAfter(3.99))).toEqual([]);
    const [cmd] = planHoldMaintenance(b.state, daysAfter(4)) as ReauthorizeCommand[];
    expect(cmd).toEqual({
      kind: "reauthorize",
      driveId: "drv1",
      pledgeId: "a",
      authorizationId: "AUTH-a",
      amount: yen(10_000),
      requestId: "reauth:drv1:a:1",
      attempt: 1,
      explicit: false,
    });
    b.event("Reauthorized", daysAfter(4), { pledgeId: "a", requestId: cmd.requestId, authorizationId: "AUTH-a-2" });
    expect(kinds(b, daysAfter(10))).toEqual([]);
  });

  it("never reauthorizes a card hold", () => {
    const b = oneHold({ source: "card" });
    expect(kinds(b, daysAfter(4))).toEqual([]);
    expect(() => planExplicitReauthorize(b.state, "a", daysAfter(5))).toThrow(/only PayPal-account holds/);
  });

  it("reauthorizes what is still uncaptured, and not while a capture is in flight", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 3000), daysAfter(1));
    const [cap] = planCaptures(b.state, daysAfter(2));
    b.submit(cap, daysAfter(2));
    expect(kinds(b, daysAfter(4))).toEqual([]);
    b.confirm(cap, daysAfter(4.1));
    expect(planHoldMaintenance(b.state, daysAfter(4.2))[0]).toMatchObject({ kind: "reauthorize", amount: yen(7000) });
  });

  it("a second reauthorize only by explicit command", () => {
    const b = oneHold();
    expect(() => planExplicitReauthorize(b.state, "a", daysAfter(3))).toThrow(/day 3: reauthorize opens on day 4/);
    b.event("Reauthorized", daysAfter(4), { pledgeId: "a", requestId: "reauth:drv1:a:1", authorizationId: "AUTH-a-2" });
    const cmd = planExplicitReauthorize(b.state, "a", daysAfter(8));
    expect(cmd).toMatchObject({ requestId: "reauth:drv1:a:2", attempt: 2, explicit: true, authorizationId: "AUTH-a-2" });
    expect(() => planExplicitReauthorize(b.state, "a", daysAfter(29))).toThrow(/days are over/);
    expect(() => planExplicitReauthorize(b.state, "zz", daysAfter(8))).toThrow(/unknown_pledge/);
  });

  it("day 26: asks the donor once to renew a hold with money left", () => {
    const b = oneHold();
    b.event("Reauthorized", daysAfter(4), { pledgeId: "a", requestId: "reauth:drv1:a:1", authorizationId: "AUTH-a-2" });
    expect(kinds(b, daysAfter(25.9))).toEqual([]);
    const [cmd] = planHoldMaintenance(b.state, daysAfter(26));
    expect(cmd).toEqual({ kind: "renewal_request", driveId: "drv1", pledgeId: "a", available: yen(10_000), expiresAt: daysAfter(29) });
    b.apply(renewalRequestedEvent(cmd as never, daysAfter(26)));
    expect(kinds(b, daysAfter(27))).toEqual([]);
  });

  it("no renewal for a hold with nothing left", () => {
    const b = oneHold({ source: "card" });
    b.fund(line("r1", 1, "water", 1, 10_000), daysAfter(1));
    expect(kinds(b, daysAfter(26))).toEqual([]);
  });

  it("day 29 without events: the hold expires and what is left is released", () => {
    const b = oneHold({ source: "card" });
    b.fund(line("r1", 1, "water", 1, 300), daysAfter(1));
    const [c] = planCaptures(b.state, daysAfter(2));
    b.submit(c, daysAfter(2)).confirm(c, daysAfter(2));
    const cmds = planHoldMaintenance(b.state, daysAfter(29));
    expect(cmds).toEqual([{ kind: "expire", driveId: "drv1", pledgeId: "a" }]);
    b.apply(holdExpiredEvent(cmds[0] as never, daysAfter(29)));
    expect(b.state.pledges.a.status).toBe("expired");
    expect(b.state.holds.a).toMatchObject({ captured: 300, released: 9700, uncollected: 0 });
    expect(kinds(b, daysAfter(30))).toEqual([]);
  });

  it("a revoked hold: capture what accrued, then void", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    b.event("PledgeRevoked", hoursAfter(2), { pledgeId: "a" });
    expect(kinds(b, hoursAfter(2))).toEqual([]); // still accrued: capture first
    const [cap] = planCaptures(b.state, hoursAfter(2));
    b.submit(cap, hoursAfter(2));
    expect(kinds(b, hoursAfter(2))).toEqual([]); // capture in flight
    b.confirm(cap, hoursAfter(3));
    expect(planHoldMaintenance(b.state, hoursAfter(3))).toEqual([
      { kind: "void", driveId: "drv1", pledgeId: "a", authorizationId: "AUTH-a", requestId: "void:drv1:a", reason: "revoked" },
    ]);
    expect(kinds(b, daysAfter(5))).toEqual(["void"]); // no reauthorize or renewal for a revoked pledge

    const fresh = oneHold();
    fresh.event("PledgeRevoked", hoursAfter(2), { pledgeId: "a" });
    expect(kinds(fresh, hoursAfter(2))).toEqual(["void"]);
  });

  it("no reauthorize or renewal once the drive is closing; the money left is voided", () => {
    const b = oneHold();
    b.event("DriveClosing", daysAfter(1), {});
    expect(kinds(b, daysAfter(27))).toEqual(["void"]);
    expect(() => planExplicitReauthorize(b.state, "a", daysAfter(5))).toThrow(/drive is closing/);
  });
});

describe("planClose (SPEC §6)", () => {
  it("is refused while the drive is open", () => {
    expect(() => planClose(oneHold().state, T0)).toThrow(/DriveClosing/);
  });

  it("captures everything accrued, voids only after confirmation, then closes", () => {
    const b = oneHold();
    b.pledge({ id: "empty", needId: "water", amount: yen(500) }, T0, "card");
    b.fund(line("r1", 1, "water", 1, 3000), hoursAfter(1)); // splits 2857 / 143 by capacity
    b.event("DriveClosing", hoursAfter(2), {});
    const first = planClose(b.state, hoursAfter(2));
    expect(first.map((c) => [c.kind, "pledgeId" in c ? c.pledgeId : "", c.kind === "capture" ? c.reasons : []])).toEqual([
      ["capture", "a", ["closing"]],
      ["capture", "empty", ["closing"]],
    ]);
    for (const c of first) if (c.kind === "capture") b.submit(c, hoursAfter(2));
    expect(planClose(b.state, hoursAfter(2))).toEqual([]); // waiting for confirmations
    const caps = first.filter((c) => c.kind === "capture");
    b.confirm(caps[0] as never, hoursAfter(2.1));
    expect(planClose(b.state, hoursAfter(2.1)).map((c) => [c.kind, "pledgeId" in c ? c.pledgeId : ""])).toEqual([["void", "a"]]);
    b.confirm(caps[1] as never, hoursAfter(2.1));
    const voids = planClose(b.state, hoursAfter(2.1));
    expect(voids.map((c) => [c.kind, c.kind === "void" ? c.reason : ""])).toEqual([
      ["void", "close"],
      ["void", "close"],
    ]);
    for (const v of voids) if (v.kind === "void") b.event("HoldVoided", hoursAfter(2.2), { pledgeId: v.pledgeId });
    expect(planClose(b.state, hoursAfter(2.2))).toEqual([{ kind: "close_drive", driveId: "drv1" }]);
    b.event("DriveClosed", hoursAfter(2.2), {});
    expect(planClose(b.state, hoursAfter(3))).toEqual([]);
  });

  it("does not void a fully captured hold, and expires one past its life", () => {
    const b = oneHold();
    b.pledge({ id: "full", needId: "water", amount: yen(100) }, daysAfter(1));
    b.fund(line("r1", 1, "water", 1, 100), daysAfter(1)); // capacities 10,000 and 100 -> 99 / 1
    b.event("HoldVoided", daysAfter(1), { pledgeId: "a" });
    b.fund(line("r1", 2, "water", 1, 99), daysAfter(1)); // all of what is left on "full"
    const [c] = planCaptures(b.state, daysAfter(1), { force: true });
    b.submit(c, daysAfter(1)).confirm(c, daysAfter(1));
    expect(b.state.pledges.full.status).toBe("captured");
    b.pledge({ id: "late", needId: "water", amount: yen(100) }, daysAfter(1));
    b.event("DriveClosing", daysAfter(31), {});
    expect(planClose(b.state, daysAfter(31))).toEqual([{ kind: "expire", driveId: "drv1", pledgeId: "late" }]);
  });
});

describe("planPayout (SPEC §7)", () => {
  it("pays the funded part of a receipt, idempotent by sender_batch_id", () => {
    const b = oneHold();
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    b.fund(line("r1", 2, "water", 1, 200), hoursAfter(1));
    b.fund(line("r2", 1, "water", 1, 50), hoursAfter(1));
    expect(planPayout(b.state, "r1")).toEqual({
      kind: "payout",
      driveId: "drv1",
      receiptId: "r1",
      senderBatchId: "pay:drv1:r1",
      amount: yen(500),
      attempt: 1,
      retry: false,
    });
    expect(planPayout(b.state, "r2")!.amount).toEqual(yen(50));
  });

  it("pays nothing for a receipt with no funded lines and refuses an unknown receipt", () => {
    const b = oneHold();
    b.apply({ id: "rej", at: T0, driveId: "drv1", type: "LineRejected", receiptId: "r1", lineNo: 1, needId: null, needQty: null, amountBase: 400, code: "alcohol", reasonEn: "" });
    expect(planPayout(b.state, "r1")).toBeNull();
    expect(() => planPayout(b.state, "r404")).toThrow(/unknown_receipt/);
    expect(() => planPayout(applyEvent(b.state, { id: "c", at: T0, driveId: "drv1", type: "DriveClosing" }), "r404")).toThrow(/unknown_receipt/);
  });

  it("pays only the funded part of a partly unfunded line", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 10)]).pledge({ id: "a", needId: "water", amount: yen(100) });
    b.fund(line("r1", 1, "water", 1, 300), hoursAfter(1));
    expect(planPayout(b.state, "r1")!.amount).toEqual(yen(100));
  });
});
