import { describe, expect, it } from "vitest";
import type { VolunteerInvited } from "./events";
import { applyEvent } from "./ledger";
import { payoutSubmittedEvent, planPayout } from "./plan";
import { Book, hoursAfter, line, makeDrive, makeNeed } from "./testing/builders";
import { volunteerList } from "./views";

// Volunteers by invitation: the coordinator invites a volunteer by name and PayPal
// address; a payout goes only to the invited volunteer whose receipt it pays, never
// to anyone removed, and never above the volunteer's limit. The book records who
// invited whom, and every payout names its volunteer.

const T = (h: number) => hoursAfter(h);
const invite = (b: Book, id: string, over: Partial<VolunteerInvited["volunteer"]> = {}, at = T(0)) =>
  b.apply({
    id: `vol:${id}`,
    at,
    driveId: "drv1",
    type: "VolunteerInvited",
    volunteer: { id, name: `Volunteer ${id}`, payoutEmail: `${id}@example.com`, tokenHash: `hash-${id}`, limitBase: null, firstReceiptCheck: true, ...over },
    by: "coordinator",
  });

/** Water 40 (JPY); a donor and the match fund everything. */
function story() {
  const b = new Book(makeDrive(), [makeNeed("water", 40)]);
  b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 100_000 } });
  b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 100_000 }, ratio: { ratioNum: 1, ratioDen: 1 } });
  return b;
}

describe("volunteers: payouts only to invited, active volunteers, within their limit", () => {
  it("pays a receipt to the volunteer who brought it, and records who it was", () => {
    const b = story();
    invite(b, "haruto");
    b.fund(line("r1", 1, "water", 4, 432), T(1));
    const cmd = planPayout(b.state, "r1", "haruto")!;
    expect(cmd).toMatchObject({ kind: "payout", receiptId: "r1", volunteerId: "haruto", amount: { currency: "JPY", minor: 432 } });
    b.apply(payoutSubmittedEvent(cmd, T(1)));
    expect(b.state.payouts.r1[0]).toMatchObject({ volunteerId: "haruto", amount: 432, status: "pending" });
    // a retry of the same payout keeps the same volunteer; another volunteer is refused
    expect(planPayout(b.state, "r1", "haruto")).toMatchObject({ retry: true, volunteerId: "haruto" });
    invite(b, "maria");
    expect(() => planPayout(b.state, "r1", "maria")).toThrow(/haruto/);
    const lst = volunteerList(b.state);
    expect(lst.map((v) => [v.id, v.name, v.payoutMasked, v.active, v.pendingBase, v.paidBase])).toEqual([
      ["haruto", "Volunteer haruto", "h***@example.com", true, 432, 0],
      ["maria", "Volunteer maria", "m***@example.com", true, 0, 0],
    ]);
    expect(JSON.stringify(lst)).not.toContain("haruto@example.com"); // the address itself never leaves the book's view
    // the book refuses it too: after haruto's payout failed, a second one written by hand to maria
    b.apply({ id: "pf1", at: T(2), driveId: "drv1", type: "PayoutFailed", receiptId: "r1", senderBatchId: cmd.senderBatchId, reason: "RECEIVER_UNREGISTERED" });
    const toMaria = { id: "po-maria", at: T(3), driveId: "drv1", type: "PayoutSubmitted" as const, receiptId: "r1", senderBatchId: "pay:drv1:r1:2", amount: { currency: "JPY" as const, minor: 432 }, volunteerId: "maria" };
    expect(() => b.apply(toMaria)).toThrow(/paid to haruto, not maria/);
  });

  it("refuses a payout to nobody, to a stranger, or to a removed volunteer once the drive invites volunteers", () => {
    const b = story();
    invite(b, "haruto");
    b.fund(line("r1", 1, "water", 4, 432), T(1));
    expect(() => planPayout(b.state, "r1")).toThrow(/pays only an invited volunteer: the payout must name one/);
    expect(() => planPayout(b.state, "r1", "stranger")).toThrow(/stranger/);
    b.apply({ id: "rm", at: T(2), driveId: "drv1", type: "VolunteerRemoved", volunteerId: "haruto", by: "coordinator" });
    expect(() => planPayout(b.state, "r1", "haruto")).toThrow(/removed/);
    // a forged PayoutSubmitted is refused by the book too
    const forged = { id: "po-f", at: T(3), driveId: "drv1", type: "PayoutSubmitted" as const, receiptId: "r1", senderBatchId: "pay:drv1:r1", amount: { currency: "JPY" as const, minor: 432 }, volunteerId: "haruto" };
    expect(() => applyEvent(b.state, forged)).toThrow(/removed/);
    expect(() => applyEvent(b.state, { ...forged, volunteerId: undefined })).toThrow(/the payout must name one/);
  });

  it("keeps a drive without invitations as it was: the drive's own payout address, no volunteer named", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 4, 432), T(1));
    const cmd = planPayout(b.state, "r1")!;
    expect(cmd.volunteerId).toBeUndefined();
    b.apply(payoutSubmittedEvent(cmd, T(1)));
    expect(b.state.payouts.r1[0].volunteerId).toBeUndefined();
  });

  it("never pays a volunteer above their limit: the rest waits until the coordinator raises it", () => {
    const b = story();
    invite(b, "haruto", { limitBase: 1000 });
    b.fund(line("r1", 1, "water", 4, 800), T(1));
    b.fund(line("r2", 1, "water", 4, 400), T(1));
    const p1 = planPayout(b.state, "r1", "haruto")!;
    b.apply(payoutSubmittedEvent(p1, T(1)));
    expect(() => planPayout(b.state, "r2", "haruto")).toThrow(/limit/); // 800 + 400 > 1000
    // exactly at the boundary: one yen short is refused, the limit itself is allowed
    b.apply({ id: "lim0", at: T(2), driveId: "drv1", type: "VolunteerLimitSet", volunteerId: "haruto", limitBase: 1199, by: "coordinator" });
    expect(() => planPayout(b.state, "r2", "haruto")).toThrow(/limit/); // 1200 > 1199
    b.apply({ id: "lim", at: T(2), driveId: "drv1", type: "VolunteerLimitSet", volunteerId: "haruto", limitBase: 1200, by: "coordinator" });
    expect(planPayout(b.state, "r2", "haruto")).toMatchObject({ amount: { minor: 400 } });
    // a failed payout frees its part of the limit; a confirmed one keeps it
    expect(volunteerList(b.state)[0]).toMatchObject({ limitBase: 1200, pendingBase: 800, paidBase: 0 });
  });

  it("refuses bad invitations: a repeated id or address, an empty name, a non-positive limit, after the close", () => {
    const b = story();
    invite(b, "haruto");
    expect(() => invite(b, "haruto")).not.toThrow(); // the same event id again: a no-op
    expect(() => b.apply({ id: "vol:dup", at: T(1), driveId: "drv1", type: "VolunteerInvited", volunteer: { id: "haruto", name: "x", payoutEmail: "x@example.com", tokenHash: "h2", limitBase: null, firstReceiptCheck: true }, by: "c" })).toThrow(/already/);
    const ev = (over: Partial<VolunteerInvited["volunteer"]>): VolunteerInvited => ({ id: `v-${JSON.stringify(over)}`, at: T(1), driveId: "drv1", type: "VolunteerInvited", volunteer: { id: "x", name: "X", payoutEmail: "x@example.com", tokenHash: "hx", limitBase: null, firstReceiptCheck: true, ...over }, by: "c" });
    expect(() => applyEvent(b.state, ev({ payoutEmail: "haruto@example.com" }))).toThrow(/address/);
    expect(() => applyEvent(b.state, ev({ name: " " }))).toThrow(/name/);
    expect(() => applyEvent(b.state, ev({ payoutEmail: "not-an-address" }))).toThrow(/address/);
    expect(() => applyEvent(b.state, ev({ limitBase: 0 }))).toThrow(/limit/);
    expect(() => applyEvent(b.state, ev({ tokenHash: "hash-haruto" }))).toThrow(/token/);
    b.event("DriveClosing", T(2), {});
    expect(() => applyEvent(b.state, ev({}))).toThrow(/closing/);
  });

  it("takes the first invitation only before the first receipt line (those lines are paid to the drive's own address)", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 4, 432), T(1));
    expect(() => invite(b, "late")).toThrow(/before the drive's first receipt/);
    const c = story();
    invite(c, "first");
    c.fund(line("r1", 1, "water", 4, 432), T(1));
    expect(() => invite(c, "second", {}, T(2))).not.toThrow(); // later invitations are fine
  });

  it("invites a removed volunteer's address again, under a new id and link", () => {
    const b = story();
    invite(b, "haruto");
    b.apply({ id: "rm", at: T(1), driveId: "drv1", type: "VolunteerRemoved", volunteerId: "haruto", by: "coordinator" });
    invite(b, "haruto2", { payoutEmail: "haruto@example.com", tokenHash: "hash-new" }, T(2));
    expect(volunteerList(b.state).map((v) => [v.id, v.active])).toEqual([
      ["haruto", false],
      ["haruto2", true],
    ]);
  });
});
