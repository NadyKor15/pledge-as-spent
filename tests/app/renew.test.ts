import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, type PledgeRenewed } from "../../src/core";
import { drives, events } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { FAKE_EPOCH, fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// A hold ends 29 days after the donor's first approval (a reauthorize keeps the
// day). RENEW_ENABLED: the donor renews from the statement with a NEW order for
// what the hold has not promised, approved again; the book links the two holds,
// the old one captures what it owes and is voided. No e-mails: the statement
// shows the end and, in the last 3 days, a reminder.

vi.setConfig({ testTimeout: 60_000 });

async function setup(driveId = "demo-renew", opts: { real?: boolean } = {}) {
  // PayPal's create_time follows the test's clock, so a renewal approved later ends later.
  let now: () => string = () => FAKE_EPOCH;
  const pp = fakeSandbox({ now: () => now() });
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  now = () => h.clock.now();
  await h.svc.createDemoDrive({ driveId });
  // a real drive: the donor approves in the PayPal window (the demo flag only decides that here)
  if (opts.real) await h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, driveId));
  const book = async () => h.db.db.select().from(events).where(eq(events.driveId, driveId));
  const links = async () => (await book()).filter((e) => e.type === "PledgeRenewed").map((e) => e.payload as PledgeRenewed);
  const hold = async (id: string) => (await h.svc.getDriveView(driveId)).holds.find((x) => x.pledgeId === id)!;
  return { pp, rec, h, driveId, book, links, hold, lena: `${driveId}.water`, mark: `${driveId}.diapers`, yuki: `${driveId}.batteries` };
}

const L = (needId: string, qty: number, amount: number): SyntheticLine => ({ needId, qty, amount });

/** A capture is confirmed only by PayPal (webhook, or the lookup after the grace period); the void follows it. */
async function confirm(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 3; i++) {
    s.h.clock.advance(60_000);
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 });
  }
}

async function reject(p: Promise<unknown>): Promise<ServiceError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

describe("renew switched off", () => {
  beforeEach(() => vi.stubEnv("RENEW_ENABLED", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("is refused, the statement offers nothing and PayPal is not asked", async () => {
    const s = await setup();
    const calls = s.pp.calls.length;
    expect(await reject(s.h.svc.renewPledge(s.lena))).toMatchObject({ status: 404, code: "renew_disabled" });
    expect((await s.h.svc.getStatement(s.lena)).renewal).toBeNull();
    expect((await s.h.svc.getDriveView(s.driveId)).features.renew).toBe(false);
    expect(s.pp.calls.length).toBe(calls);
  });
});

describe("renew switched on", () => {
  beforeEach(() => vi.stubEnv("RENEW_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("shows the end of the hold on the statement, and the reminder only in its last 3 days", async () => {
    const s = await setup();
    const r0 = (await s.h.svc.getStatement(s.lena)).renewal!;
    expect(r0).toMatchObject({ remind: false, refusal: null, pending: null, renewedTo: null, approval: "sandbox_test_card", available: { currency: "EUR", minor: 2000 } });
    expect(Date.parse(r0.expiresAt!) - Date.parse(r0.remindFrom!)).toBe(3 * DAY_MS);
    s.h.clock.set(new Date(Date.parse(r0.remindFrom!) + 1000).toISOString());
    expect((await s.h.svc.getStatement(s.lena)).renewal).toMatchObject({ remind: true, refusal: null });
    s.h.clock.set(new Date(Date.parse(r0.expiresAt!) + 1000).toISOString());
    expect((await s.h.svc.getStatement(s.lena)).renewal).toMatchObject({ remind: false, refusal: { code: "expired" } });
    expect(await reject(s.h.svc.renewPledge(s.lena))).toMatchObject({ status: 409, code: "renewal_refused" });
  });

  it("demo drive: renews Lena's rest with a new sandbox order; the old hold captures what it owes and is voided", async () => {
    const s = await setup();
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 601, [L("water", 10, 1080)]).bytes });
    const before = await s.hold(s.lena);
    const rest = before.available;
    expect(before.accrued).toBeGreaterThan(0);
    const calls = s.pp.calls.length;

    s.h.clock.advance(27 * DAY_MS); // the reminder's days
    expect((await s.h.svc.getStatement(s.lena)).renewal).toMatchObject({ remind: true });
    const out = await s.h.svc.renewPledge(s.lena);
    expect(out).toMatchObject({ pledgeId: `${s.lena}.r1`, renews: s.lena, status: "authorized", approval: "sandbox_test_card" });
    const made = () => s.pp.calls.slice(calls).map((c) => `${c.method} ${c.path}`);
    expect(made()).toEqual(["POST /v2/checkout/orders", `POST /v2/payments/authorizations/${before.authorizationId}/capture`]); // the new order, then Lena's accrued share
    expect(await s.links()).toEqual([expect.objectContaining({ pledgeId: out.pledgeId, fromPledgeId: s.lena })]);
    expect(await s.hold(s.lena)).toMatchObject({ status: "authorized", available: 0, renewedTo: out.pledgeId }); // funds nothing new already
    await confirm(s); // PayPal confirms the capture; the void of the old hold follows
    expect(made()).toContain(`POST /v2/payments/authorizations/${before.authorizationId}/void`);
    const old = await s.hold(s.lena);
    expect(old).toMatchObject({ status: "voided", renewedTo: out.pledgeId, captured: before.accrued, released: rest });
    const nw = await s.hold(out.pledgeId);
    expect(nw).toMatchObject({ renews: s.lena, status: "authorized", currency: "EUR", authorized: rest, available: rest, needId: "water" });
    expect(Date.parse(nw.expiresAt!) - Date.parse(old.expiresAt!)).toBe(27 * DAY_MS); // 29 days from the new approval

    // the next water line draws on the renewal, never on the voided hold
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 602, [L("water", 5, 540)]).bytes });
    const rows = (await s.h.svc.getDriveView(s.driveId)).ledger.filter((x) => x.receiptId.endsWith(".r2") && x.kind === "donor_share");
    expect(rows.map((x) => x.pledgeId)).toEqual([out.pledgeId]);
    // the chain never promised more than Lena's €20.00
    const after = await Promise.all([s.hold(s.lena), s.hold(out.pledgeId)]);
    expect(after.reduce((a, h) => a + h.captured + h.capturePending + h.accrued + h.uncollected + h.reversed, 0)).toBeLessThanOrEqual(2000);
    // the old statement points to the new one, the new one back
    expect((await s.h.svc.getStatement(s.lena)).renewal).toMatchObject({ renewedTo: out.pledgeId, refusal: { code: "renewed" } });
    expect((await s.h.svc.getStatement(out.pledgeId)).renewal).toMatchObject({ renews: s.lena, refusal: null });
  });

  it("real drive: a new PAY_NOW order the donor approves again; a double click waits for the same order", async () => {
    const s = await setup("real-renew", { real: true });
    const first = await s.h.svc.renewPledge(s.lena);
    expect(first).toMatchObject({ pledgeId: `${s.lena}.r1`, status: "PAYER_ACTION_REQUIRED", approval: "paypal_window", approveUrl: expect.stringContaining(first.orderId) });
    const calls = s.pp.calls.length;
    const twice = await s.h.svc.renewPledge(s.lena);
    expect(twice).toMatchObject({ pledgeId: first.pledgeId, orderId: first.orderId });
    expect(s.pp.calls.length).toBe(calls); // the second press asks PayPal nothing
    // nothing changes before the donor approves: Lena's hold keeps funding
    expect((await s.hold(s.lena)).available).toBe(2000);
    expect(await s.links()).toEqual([]);
    expect((await s.h.svc.getStatement(s.lena)).renewal).toMatchObject({ pending: { pledgeId: first.pledgeId } });

    s.pp.approve(first.orderId);
    expect(await s.h.svc.approvePledge(first.pledgeId, first.orderId)).toMatchObject({ status: "authorized" });
    expect(await s.h.svc.approvePledge(first.pledgeId, first.orderId)).toMatchObject({ status: "authorized" }); // the return twice
    expect(await s.links()).toHaveLength(1);
    expect(await s.hold(s.lena)).toMatchObject({ status: "voided", renewedTo: first.pledgeId });
    expect(await s.hold(first.pledgeId)).toMatchObject({ paymentSource: "paypal", available: 2000 });
    await s.h.svc.runDaily();
    expect(await s.links()).toHaveLength(1);
  });

  it("a line funded while the donor is in the PayPal window trims the renewal: never charged more than pledged", async () => {
    const s = await setup("real-renew-race", { real: true });
    const r = await s.h.svc.renewPledge(s.lena); // asks for all €20.00
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 603, [L("water", 10, 1080)]).bytes });
    const used = (await s.hold(s.lena)).accrued;
    expect(used).toBeGreaterThan(0);
    s.pp.approve(r.orderId);
    await s.h.svc.approvePledge(r.pledgeId, r.orderId);
    const nw = await s.hold(r.pledgeId);
    expect(nw).toMatchObject({ authorized: 2000, available: 2000 - used, surplus: used });
    // closing the drive lets the surplus go at PayPal: nothing of it was ever charged
    await s.h.svc.closeDrive(s.driveId);
    await confirm(s);
    expect((await s.h.svc.getDriveView(s.driveId)).drive.status).toBe("closed");
    const report = (await s.h.svc.getDriveView(s.driveId)).closeReport;
    const chain = report.filter((x) => x.pledgeId === s.lena || x.pledgeId === r.pledgeId);
    expect(chain.every((x) => x.settled)).toBe(true);
    expect(chain.reduce((a, x) => a + x.spent, 0)).toBe(used);
    expect(chain.find((x) => x.pledgeId === r.pledgeId)!.released).toBe(2000);
  });

  it("refuses a withdrawn hold, a hold with nothing left and a closed drive, before PayPal is asked", async () => {
    const s = await setup();
    await s.h.svc.revokePledge(s.lena);
    const calls = s.pp.calls.length;
    expect(await reject(s.h.svc.renewPledge(s.lena))).toMatchObject({ status: 409, extra: { rule: "hold_not_live" } });
    expect(await reject(s.h.svc.renewPledge(`${s.driveId}.match`))).toMatchObject({ status: 409, extra: { rule: "not_donor" } });
    expect(await reject(s.h.svc.renewPledge("nobody"))).toMatchObject({ status: 404 });
    await s.h.svc.closeDrive(s.driveId);
    expect(await reject(s.h.svc.renewPledge(s.mark))).toMatchObject({ status: 409, extra: { rule: "drive_not_open" } });
    expect(s.pp.calls.filter((c) => c.path.includes("/checkout/orders")).length).toBe(s.pp.calls.slice(0, calls).filter((c) => c.path.includes("/checkout/orders")).length);
  });

  it("renews holds in euros, dollars and yen, each in its own currency", async () => {
    const s = await setup();
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 604, [L("water", 4, 432), L("diapers", 1, 1298), L("batteries", 8, 880)]).bytes });
    for (const [id, currency] of [
      [s.lena, "EUR"],
      [s.mark, "USD"],
      [s.yuki, "JPY"],
    ] as const) {
      const before = await s.hold(id);
      const out = await s.h.svc.renewPledge(id);
      await confirm(s);
      const nw = await s.hold(out.pledgeId);
      expect(nw).toMatchObject({ currency, authorized: before.available, available: before.available, renews: id });
      expect(await s.hold(id)).toMatchObject({ status: "voided", captured: before.accrued });
    }
  });
});
