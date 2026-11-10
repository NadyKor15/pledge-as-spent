import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drives, receipts } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// Volunteers by invitation (VOLUNTEER_INVITES). The coordinator invites a volunteer by
// name and PayPal address; only an invited volunteer's upload link takes receipts, a
// person checks each new volunteer's first receipt, a limit caps what one volunteer is
// paid, and the payout goes to that volunteer's PayPal address, never anyone else's.

vi.setConfig({ testTimeout: 60_000 });

const DEMO_EMAIL = "sb-pywsi53523660@personal.example.com";
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
  return { pp, rec, h, driveId, upload, receiptRows };
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
    expect(s.pp.payouts).toEqual([expect.objectContaining({ receiver: DEMO_EMAIL, minor: 432 })]);
    const book = await s.h.svc.getDriveView(s.driveId);
    expect(book.payouts[0].attempts[0]).toMatchObject({ volunteerId: "demo-volunteer" });
  });

  it("real drive: only an invited volunteer's link takes receipts; the first is checked by a person; payouts go to that volunteer", async () => {
    const s = await setup("real-vol", { real: true });
    const calls = s.pp.calls.length;
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" });
    expect(inv.uploadPath).toContain(encodeURIComponent(inv.token));
    // no link, a wrong link: refused before the (paid) reading, nothing stored, PayPal not asked
    expect(await reject(s.upload(803, [L("water", 4, 432)]))).toMatchObject({ status: 403, code: "invited_only" });
    expect(await reject(s.upload(803, [L("water", 4, 432)], "not-a-real-token"))).toMatchObject({ status: 403, code: "invalid_volunteer_link" });
    expect(await s.receiptRows()).toEqual([]);
    expect(s.pp.calls.length).toBe(calls);

    // her first receipt: a person checks it; no money moves yet
    const first = await s.upload(804, [L("water", 4, 432)], inv.token);
    expect(first.receipt.status).toBe("review");
    expect(first.receipt.flags.map((f) => f.code)).toEqual(["first_receipt"]);
    expect(s.pp.payouts).toEqual([]);
    await s.h.svc.coordinatorDecision(first.receipt.id, "approve", "Checked the photo with Maria");
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

  it("a removed volunteer's link stops at once", async () => {
    const s = await setup("real-vol-rm", { real: true });
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com", firstReceiptCheck: false });
    await s.h.svc.removeVolunteer(s.driveId, inv.volunteerId);
    expect(await reject(s.upload(806, [L("water", 4, 432)], inv.token))).toMatchObject({ status: 403, code: "volunteer_removed" });
    expect((await s.h.svc.getDriveView(s.driveId)).volunteers).toEqual([expect.objectContaining({ active: false })]);
  });

  it("never pays a volunteer above their limit: the receipt waits for the coordinator, then pays when the limit is raised", async () => {
    const s = await setup("real-vol-limit", { real: true });
    const inv = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com", limitMinor: 500, firstReceiptCheck: false });
    const a = await s.upload(807, [L("water", 4, 432)], inv.token);
    expect(a.receipt.status).toBe("funded");
    const b = await s.upload(808, [L("water", 4, 432)], inv.token); // 432 + 432 > 500
    expect(b.receipt.status).toBe("review");
    expect(b.receipt.flags.map((f) => f.code)).toEqual(["volunteer_limit"]);
    await s.h.svc.coordinatorDecision(b.receipt.id, "approve", "Bought for the shelter, limit to be raised");
    expect(s.pp.payouts.map((p) => p.minor)).toEqual([432]); // funded, but not paid above the limit
    const r = await s.h.svc.setVolunteerLimit(s.driveId, inv.volunteerId, 1000);
    expect(r).toMatchObject({ limitBase: 1000 });
    expect(s.pp.payouts.map((p) => [p.receiver, p.minor])).toEqual([
      ["maria@example.com", 432],
      ["maria@example.com", 432],
    ]);
  });

  it("refuses a bad invitation with a sentence: no name, no address, an address already invited", async () => {
    const s = await setup("real-vol-bad", { real: true });
    await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: " ", payoutEmail: "x@example.com" }))).toMatchObject({ status: 400, code: "invalid_volunteer" });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "X", payoutEmail: "nope" }))).toMatchObject({ status: 400 });
    expect(await reject(s.h.svc.inviteVolunteer(s.driveId, { name: "Maria 2", payoutEmail: "MARIA@example.com" }))).toMatchObject({ status: 400, message: expect.stringMatching(/already invited/) });
  });
});
