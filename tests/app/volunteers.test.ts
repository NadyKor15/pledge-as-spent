import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drives, receipts } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { limitField } from "../../src/server/volunteer-fields";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// Volunteers by invitation (VOLUNTEER_INVITES). The coordinator invites a volunteer by
// name and PayPal address; only an invited volunteer's upload link takes receipts, a
// person checks each new volunteer's first receipt, a limit caps what one volunteer is
// paid, and the payout goes to that volunteer's PayPal address, never anyone else's.
// On a real drive only the coordinator (COORDINATOR_SECRET bearer) invites, changes
// volunteers and decides on their receipts.

vi.setConfig({ testTimeout: 60_000 });

const DEMO_EMAIL = "sb-pywsi53523660@personal.example.com";
const COORD = { coordinator: true };
const L = (needId: string, qty: number, amount: number): SyntheticLine => ({ needId, qty, amount });

async function setup(driveId: string, opts: { real?: boolean; seeded?: boolean } = {}) {
  vi.stubEnv("VOLUNTEER_INVITES", opts.seeded ? "1" : "");
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  if (opts.real) await h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, driveId));
  vi.stubEnv("VOLUNTEER_INVITES", "1");
  const receiptRows = async () => h.db.db.select({ id: receipts.id, status: receipts.status }).from(receipts).where(eq(receipts.driveId, driveId));
  const upload = (seed: number, lines: SyntheticLine[], volunteerToken?: string) => h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, seed, lines).bytes, volunteerToken });
  const approve = (id: string, why = "Checked with the volunteer") => h.svc.coordinatorDecision(id, "approve", why, COORD);
  return { pp, rec, h, driveId, upload, receiptRows, approve };
}

async function reject(p: Promise<unknown>): Promise<ServiceError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

afterEach(() => vi.unstubAllEnvs());

describe("the limit field", () => {
  it("takes a whole number or \"none\", and never reads a typo or a NaN as no limit", () => {
    expect(limitField("500", { absentMeansNone: false })).toBe(500);
    expect(limitField(500, { absentMeansNone: false })).toBe(500);
    expect(limitField("none", { absentMeansNone: false })).toBeNull();
    expect(limitField(undefined, { absentMeansNone: true })).toBeNull();
    for (const bad of ["$500", "500 USD", "1.5", "0", -3, null, Number.NaN]) expect(() => limitField(bad, { absentMeansNone: false })).toThrow(/limitMinor/);
    expect(() => limitField(undefined, { absentMeansNone: false })).toThrow(/required/);
  });
});

describe("volunteer invitations switched off", () => {
  it("cannot invite; the drive pays its own address as before and its view has no volunteers", async () => {
    vi.stubEnv("VOLUNTEER_INVITES", "");
    const pp = fakeSandbox();
    const rec = loadRecordings();
    const h = await harness({ fetch: pp.fetch, recordings: rec });
    await h.svc.createDemoDrive({ driveId: "demo-vol-off" });
    expect(await reject(h.svc.inviteVolunteer("demo-vol-off", { name: "Maria", payoutEmail: "maria@example.com" }))).toMatchObject({ status: 404, code: "invites_disabled" });
    const view = await h.svc.getDriveView("demo-vol-off");
    expect("volunteers" in view).toBe(false);
    expect(view.features).toMatchObject({ invites: false });
    await h.svc.submitReceipt({ driveId: "demo-vol-off", bytes: syntheticReceipt(rec, 801, [L("water", 4, 432)]).bytes });
    expect(pp.payouts.map((p) => p.receiver)).toEqual([DEMO_EMAIL]);
  });
});

describe("volunteer invitations switched on", () => {
  it("demo drive: invites its own volunteer, so the judge's upload is funded at once and paid to the demo's sandbox volunteer", async () => {
    const s = await setup("demo-vol", { seeded: true });
    const view = await s.h.svc.getDriveView(s.driveId);
    expect(view.volunteers).toEqual([expect.objectContaining({ id: "demo-volunteer", name: "Haruto", payoutMasked: "s***@personal.example.com", active: true, firstReceiptCheck: false })]);
    expect(JSON.stringify(view)).not.toContain(DEMO_EMAIL); // the address never leaves the book
    const out = await s.upload(802, [L("water", 4, 432)]);
    expect(out.receipt.status).toBe("funded");
    expect(out.receipt).toMatchObject({ volunteerId: "demo-volunteer" });
    expect(s.pp.payouts).toEqual([expect.objectContaining({ receiver: DEMO_EMAIL, minor: 432 })]);
    expect((await s.h.svc.getDriveView(s.driveId)).payouts[0].attempts[0]).toMatchObject({ volunteerId: "demo-volunteer" });
    // the demo's own volunteer stays: nobody can remove or limit it and break the judges' path
    expect(await reject(s.h.svc.removeVolunteer(s.driveId, "demo-volunteer"))).toMatchObject({ status: 403, code: "demo_volunteer" });
    expect(await reject(s.h.svc.setVolunteerLimit(s.driveId, "demo-volunteer", 1))).toMatchObject({ status: 403, code: "demo_volunteer" });
  });

  it("a demo drive made while invitations were off invites its own volunteer with the first invitation", async () => {
    const s = await setup("demo-vol-late");
    await s.h.svc.inviteVolunteer(s.driveId, { name: "Ana", payoutEmail: "ana@example.com" }); // open on a demo drive
    expect((await s.h.svc.getDriveView(s.driveId)).volunteers!.map((v) => v.id)).toEqual(["demo-volunteer", expect.stringMatching(/^vol-/)]);
    expect((await s.upload(809, [L("water", 4, 432)])).receipt.status).toBe("funded"); // the judge's path, still one click
  });

  it("real drive: only the coordinator invites; only an invited volunteer's link takes receipts; the first is checked by a person; payouts go to that volunteer", async () => {
    const s = await setup("real-vol", { real: true });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "Mallory", payoutEmail: "mallory@example.com" }))).toMatchObject({ status: 403, code: "coordinator_only" });
    const calls = s.pp.calls.length;
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD);
    expect(inv.uploadPath).toBe(`/drive/${s.driveId}?as=volunteer&volunteer=${encodeURIComponent(inv.token)}`);
    // no link, a wrong link: refused before the (paid) reading, nothing stored, PayPal not asked
    expect(await reject(s.upload(803, [L("water", 4, 432)]))).toMatchObject({ status: 403, code: "invited_only" });
    expect(await reject(s.upload(803, [L("water", 4, 432)], "not-a-real-token"))).toMatchObject({ status: 403, code: "invalid_volunteer_link" });
    expect(await s.receiptRows()).toEqual([]);
    expect(s.pp.calls.length).toBe(calls);

    // her first receipt: a person checks it; no money moves yet; only the coordinator decides
    const first = await s.upload(804, [L("water", 4, 432)], inv.token);
    expect(first.receipt.status).toBe("review");
    expect(first.receipt.flags.map((f) => f.code)).toEqual(["first_receipt"]);
    expect(await reject(s.h.svc.coordinatorDecision(first.receipt.id, "approve", "I approve myself"))).toMatchObject({ status: 403, code: "coordinator_only" });
    expect(s.pp.payouts).toEqual([]);
    await s.approve(first.receipt.id);
    expect(s.pp.payouts).toEqual([expect.objectContaining({ receiver: "maria@example.com", minor: 432 })]);
    // her next receipt is funded at once, paid to her again
    const second = await s.upload(805, [L("water", 2, 216)], inv.token);
    expect(second.receipt.status).toBe("funded");
    expect(s.pp.payouts.map((p) => [p.receiver, p.minor])).toEqual([
      ["maria@example.com", 432],
      ["maria@example.com", 216],
    ]);
    expect((await s.h.svc.getDriveView(s.driveId)).volunteers).toEqual([expect.objectContaining({ name: "Maria", payoutMasked: "m***@example.com", pendingBase: 648, paidBase: 0 })]);
  });

  it("a removed volunteer's link stops at once, their waiting receipt can only be rejected, and their address can be invited again", async () => {
    const s = await setup("real-vol-rm", { real: true });
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD);
    const waiting = await s.upload(806, [L("water", 4, 432)], inv.token); // first receipt: in review
    expect(await reject(s.h.svc.removeVolunteer(s.driveId, inv.volunteerId))).toMatchObject({ status: 403, code: "coordinator_only" });
    await s.h.svc.removeVolunteer(s.driveId, inv.volunteerId, COORD);
    expect(await reject(s.upload(807, [L("water", 4, 432)], inv.token))).toMatchObject({ status: 403, code: "volunteer_removed" });
    expect(await reject(s.approve(waiting.receipt.id))).toMatchObject({ status: 409, code: "volunteer_removed" });
    expect((await s.h.svc.coordinatorDecision(waiting.receipt.id, "reject", "Volunteer removed", COORD)).receipt.status).toBe("rejected");
    expect(s.pp.payouts).toEqual([]);
    const again = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD);
    expect(again.volunteerId).not.toBe(inv.volunteerId);
    expect((await s.h.svc.getDriveView(s.driveId)).volunteers!.map((v) => v.active)).toEqual([false, true]);
  });

  it("never pays a volunteer above their limit: the receipt waits (and says so), then pays when the limit is raised", async () => {
    const s = await setup("real-vol-limit", { real: true });
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com", limitMinor: 500, firstReceiptCheck: false }, COORD);
    const a = await s.upload(807, [L("water", 4, 432)], inv.token);
    expect(a.receipt.status).toBe("funded");
    const b = await s.upload(808, [L("water", 4, 432)], inv.token); // 432 + 432 > 500
    expect(b.receipt.status).toBe("review");
    expect(b.receipt.flags.map((f) => f.code)).toEqual(["volunteer_limit"]);
    const decided = await s.approve(b.receipt.id, "Bought for the shelter, limit to be raised");
    expect(decided.receipt).toMatchObject({ status: "funded", payoutWaits: expect.stringMatching(/limit/) });
    expect(s.pp.payouts.map((p) => p.minor)).toEqual([432]); // funded, but not paid above the limit
    const r = await s.h.svc.setVolunteerLimit(s.driveId, inv.volunteerId, 1000, COORD);
    expect(r).toMatchObject({ limitBase: 1000 });
    expect(s.pp.payouts.map((p) => [p.receiver, p.minor])).toEqual([
      ["maria@example.com", 432],
      ["maria@example.com", 432],
    ]);
    expect("payoutWaits" in (await s.h.svc.getReceipt(b.receipt.id))).toBe(false); // the mark is cleared
  });

  it("invites only before the drive's first receipt (those are paid to the drive's own address)", async () => {
    const s = await setup("real-vol-late", { real: true });
    vi.stubEnv("VOLUNTEER_INVITES", "");
    await s.upload(810, [L("water", 4, 432)]);
    vi.stubEnv("VOLUNTEER_INVITES", "1");
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD))).toMatchObject({ status: 409, code: "receipts_before_invites" });
  });

  it("removes a volunteer even with invitations switched off: a leaked link must stop", async () => {
    const s = await setup("real-vol-off", { real: true });
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD);
    vi.stubEnv("VOLUNTEER_INVITES", "");
    await s.h.svc.removeVolunteer(s.driveId, inv.volunteerId, COORD);
    expect(await reject(s.upload(811, [L("water", 4, 432)], inv.token))).toMatchObject({ status: 403, code: "volunteer_removed" });
  });

  it("refuses a bad invitation with a sentence: no name, no address, an address already invited", async () => {
    const s = await setup("real-vol-bad", { real: true });
    await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, COORD);
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: " ", payoutEmail: "x@example.com" }, COORD))).toMatchObject({ status: 400, code: "invalid_volunteer", message: expect.not.stringMatching(/volunteer:/) });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "X", payoutEmail: "nope" }, COORD))).toMatchObject({ status: 400 });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "Maria 2", payoutEmail: "MARIA@example.com" }, COORD))).toMatchObject({ status: 400, message: expect.stringMatching(/already invited/) });
  });
});
