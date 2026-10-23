import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../../src/core";
import { drives, events } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes } from "./support/harness";

async function setup(driveId = "demo-pledges") {
  const pp = fakeSandbox();
  const h = await harness({ fetch: pp.fetch });
  await h.svc.createDemoDrive({ driveId });
  return { pp, h, driveId };
}

const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("expected a ServiceError");
};

/** A donor pledge approved in the (fake) PayPal window: a PayPal-account hold. */
async function walletPledge(s: Awaited<ReturnType<typeof setup>>, name = "Claire (Lyon)") {
  const p = await s.h.svc.createPledge({ driveId: s.driveId, needId: "water", donorName: name, donorCountry: "fr", amount: { currency: "EUR", minor: 1000 } });
  s.pp.approve(p.orderId);
  const a = await s.h.svc.approvePledge(p.pledgeId, p.orderId);
  return { ...p, ...a };
}

describe("pledges", () => {
  it("a wallet pledge: PAY_NOW order, refused before approval, authorized after it", async () => {
    const s = await setup();
    const p = await s.h.svc.createPledge({ driveId: s.driveId, needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR", minor: 1000 } });
    expect(p).toMatchObject({ status: "PAYER_ACTION_REQUIRED", approveUrl: expect.stringContaining(p.orderId) });
    expect(await reject(s.h.svc.approvePledge(p.pledgeId))).toMatchObject({ status: 409, code: "not_approved" });
    expect(await reject(s.h.svc.approvePledge(p.pledgeId, "SOMEONE-ELSES-ORDER"))).toMatchObject({ status: 400, code: "order_mismatch" });
    s.pp.approve(p.orderId);
    expect(await s.h.svc.approvePledge(p.pledgeId, p.orderId)).toMatchObject({ status: "authorized" });
    // Approving again is idempotent and makes no new PayPal call.
    const calls = s.pp.calls.length;
    expect(await s.h.svc.approvePledge(p.pledgeId)).toMatchObject({ status: "authorized" });
    expect(s.pp.calls.length).toBe(calls);
    const hold = (await s.h.svc.getDriveView(s.driveId)).holds.find((x) => x.pledgeId === p.pledgeId)!;
    expect(hold).toMatchObject({ paymentSource: "paypal", authorized: 1000, fx: expect.objectContaining({ rate: "162.35" }) });
  });

  it("refuses bad pledges before asking PayPal", async () => {
    const s = await setup();
    const base = { driveId: s.driveId, needId: "water", donorName: "X", amount: { currency: "EUR" as const, minor: 1000 } };
    const calls = s.pp.calls.length;
    expect(await reject(s.h.svc.createPledge({ ...base, needId: "rice" }))).toMatchObject({ status: 400, code: "invalid_pledge" });
    expect(await reject(s.h.svc.createPledge({ ...base, amount: { currency: "CHF" as never, minor: 1000 } }))).toMatchObject({ status: 400, code: "invalid_currency" });
    expect(await reject(s.h.svc.createPledge({ ...base, amount: { currency: "GBP", minor: 1000 } }))).toMatchObject({ status: 400, code: "no_rate" });
    expect(await reject(s.h.svc.createPledge({ ...base, amount: { currency: "EUR", minor: 0 } }))).toMatchObject({ status: 400, code: "invalid_amount" });
    expect(await reject(s.h.svc.createPledge({ ...base, amount: { currency: "EUR", minor: 12.5 } }))).toMatchObject({ status: 400, code: "invalid_amount" });
    expect(await reject(s.h.svc.createPledge({ ...base, donorName: "  " }))).toMatchObject({ status: 400, code: "invalid_donor" });
    expect(await reject(s.h.svc.createPledge({ ...base, needId: null, match: { ratioNum: 2, ratioDen: 1 } }))).toMatchObject({ status: 400, code: "invalid_pledge" });
    expect(await reject(s.h.svc.createPledge({ ...base, driveId: "nope" }))).toMatchObject({ status: 404 });
    expect(s.pp.calls.length).toBe(calls);
  });

  it("a revoked pledge funds nothing new; what it already bought is captured, then the rest is voided", async () => {
    const s = await setup();
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: heroBytes() });
    const lena = `${s.driveId}.water`;
    const r = await s.h.svc.revokePledge(lena);
    expect(r.commands.map((c) => c.kind)).toEqual(["capture"]);
    s.h.clock.advance(60_000);
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 }); // the capture is confirmed, then the void follows
    const hold = (await s.h.svc.getDriveView(s.driveId)).holds.find((x) => x.pledgeId === lena)!;
    expect(hold).toMatchObject({ revoked: true, status: "voided", captured: 458, released: 1542, available: 0 });
    // A later receipt cannot draw on Lena's hold.
    const v = await s.h.svc.getDriveView(s.driveId);
    expect(v.needs.find((n) => n.needId === "water")!.donorCapacityBase).toBe(0);
  });

  it("the demo endpoint allows 5 new drives per IP per hour", async () => {
    const pp = fakeSandbox();
    const h = await harness({ fetch: pp.fetch });
    for (let i = 0; i < 5; i++) await h.svc.createDemoDrive({ ip: "192.0.2.7" });
    expect(await reject(h.svc.createDemoDrive({ ip: "192.0.2.7" }))).toMatchObject({ status: 429, code: "demo_limit" });
    await h.svc.createDemoDrive({ ip: "192.0.2.8" });
    h.clock.advance(HOUR_MS + 1000);
    await h.svc.createDemoDrive({ ip: "192.0.2.7" });
  });
});

describe("daily job", () => {
  it("closes a demo drive older than 24 h: captures first, then voids on the next run", async () => {
    const s = await setup("demo-old");
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: heroBytes() });
    s.h.clock.advance(25 * HOUR_MS);
    const first = await s.h.svc.runDaily();
    expect(first.errors).toEqual([]);
    expect((await s.h.svc.getDriveView(s.driveId)).drive.status).toBe("closing");
    expect(s.pp.captures).toHaveLength(4);
    s.h.clock.advance(DAY_MS);
    await s.h.svc.runDaily();
    const end = await s.h.svc.getDriveView(s.driveId);
    expect(end.drive.status).toBe("closed");
    expect(s.pp.voids).toHaveLength(4);
    expect(end.payouts[0].attempts[0].status).toBe("confirmed");
    expect(end.closeReport.every((c) => c.settled)).toBe(true);
  });

  it("reauthorizes PayPal-account holds from day 4 (never card holds), asks for renewal on day 26, expires on day 29", async () => {
    const s = await setup("drive-live");
    await s.h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, s.driveId));
    const claire = await walletPledge(s);
    s.h.clock.advance(3 * DAY_MS + 23 * HOUR_MS);
    await s.h.svc.runDaily();
    expect(s.pp.reauthorizations).toEqual([]); // day 3: too soon
    s.h.clock.advance(2 * HOUR_MS);
    await s.h.svc.runDaily();
    expect(s.pp.reauthorizations).toHaveLength(1);
    const v = await s.h.svc.getDriveView(s.driveId);
    const hold = v.holds.find((x) => x.pledgeId === claire.pledgeId)!;
    expect(hold.authorizationId).toBe(s.pp.reauthorizations[0].to);
    expect(s.pp.reauthorizations[0]).toMatchObject({ from: claire.authorizationId, minor: 1000 });
    s.h.clock.advance(DAY_MS);
    await s.h.svc.runDaily();
    expect(s.pp.reauthorizations).toHaveLength(1); // once per hold

    s.h.clock.set(new Date(Date.parse(v.holds[0].expiresAt!) - 3 * DAY_MS).toISOString()); // day 26
    await s.h.svc.runDaily();
    const types = async () => (await s.h.db.db.select().from(events).where(eq(events.driveId, s.driveId))).map((e) => e.type);
    expect((await types()).filter((t) => t === "RenewalRequested")).toHaveLength(5);
    s.h.clock.set(new Date(Date.parse(hold.expiresAt!) + 1000).toISOString()); // day 29 for every hold
    await s.h.svc.runDaily();
    const end = await s.h.svc.getDriveView(s.driveId);
    expect(end.holds.map((x) => x.status)).toEqual(["expired", "expired", "expired", "expired", "expired"]);
    expect((await types()).filter((t) => t === "HoldExpired")).toHaveLength(5);
  });
});
