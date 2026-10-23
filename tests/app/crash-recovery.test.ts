import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { paypalCalls } from "../../src/db/schema";
import type { FetchLike } from "../../src/paypal/recording";
import { fakeSandbox, type FakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes } from "./support/harness";

// A crash at every step that talks to PayPal: before the request leaves (the
// outbox row is committed) and after PayPal acted but before the answer was
// recorded. A restarted process must finish the step without PayPal acting twice.

type When = "before" | "after";

/** Throws on the nth matching request, before it is sent or after PayPal answered. */
function crashOn(inner: FetchLike, match: (method: string, path: string) => boolean, when: When, nth = 1): FetchLike {
  let seen = 0;
  return async (url, init) => {
    const hit = match(init.method, new URL(url).pathname) && ++seen === nth;
    if (hit && when === "before") throw new Error("crash before send");
    const res = await inner(url, init);
    if (hit && when === "after") throw new Error("crash after PayPal answered");
    return res;
  };
}

const isOrder = (m: string, p: string) => m === "POST" && p === "/v2/checkout/orders";
const isPayout = (m: string, p: string) => m === "POST" && p === "/v1/payments/payouts";
const isCapture = (m: string, p: string) => m === "POST" && p.endsWith("/capture");
const isVoid = (m: string, p: string) => m === "POST" && p.endsWith("/void");

const fresh = (pp: FakeSandbox, test: (m: string, p: string) => boolean) => pp.calls.filter((c) => test(c.method, c.path) && !c.replayed);

async function setup() {
  const pp = fakeSandbox();
  const h = await harness({ fetch: pp.fetch });
  return { pp, h };
}

describe("crash while creating the demo holds", () => {
  for (const when of ["before", "after"] as When[]) {
    it(`${when} the second order: the rerun resumes and PayPal holds each pledge once`, async () => {
      const { pp, h } = await setup();
      await expect(h.restart(crashOn(pp.fetch, isOrder, when, 2)).createDemoDrive({ driveId: "demo-crash-holds" })).rejects.toThrow(/crash/);
      const view = await h.restart().createDemoDrive({ driveId: "demo-crash-holds" });
      expect(view.holds.map((x) => x.status)).toEqual(["authorized", "authorized", "authorized", "authorized"]);
      expect(fresh(pp, isOrder)).toHaveLength(4);
      expect(new Set(view.holds.map((x) => x.authorizationId)).size).toBe(4);
    });
  }
});

describe("crash around the volunteer payout", () => {
  for (const when of ["before", "after"] as When[]) {
    it(`${when} the payout request: the lookup finishes it and the volunteer is paid once`, async () => {
      const { pp, h } = await setup();
      const { drive } = await h.svc.createDemoDrive({ driveId: "demo-crash-pay" });
      await expect(h.restart(crashOn(pp.fetch, isPayout, when)).submitReceipt({ driveId: drive.id, bytes: heroBytes() })).rejects.toThrow(/crash/);
      // The receipt, its lines and PayoutSubmitted were committed before the request.
      const mid = await h.svc.getDriveView(drive.id);
      expect(mid.payouts[0].attempts).toEqual([expect.objectContaining({ status: "pending", amount: 10448 })]);
      await h.restart().reconcile(drive.id, { graceMinutes: 0 });
      const end = await h.svc.getDriveView(drive.id);
      expect(end.payouts[0].attempts).toEqual([expect.objectContaining({ status: "confirmed", amount: 10448 })]);
      expect(pp.payouts).toHaveLength(1);
      expect(pp.payouts[0]).toMatchObject({ minor: 10448, currency: "JPY", senderBatchId: `pay:${drive.id}:${drive.id}.r1` });
    });
  }

  it("after the request, with PayPal's answer lost: sent again under the same sender_batch_id, paid once", async () => {
    const { pp, h } = await setup();
    const { drive } = await h.svc.createDemoDrive({ driveId: "demo-crash-pay-lost" });
    await expect(h.restart(crashOn(pp.fetch, isPayout, "after")).submitReceipt({ driveId: drive.id, bytes: heroBytes() })).rejects.toThrow(/crash/);
    await h.db.db.delete(paypalCalls).where(eq(paypalCalls.path, "/v1/payments/payouts"));
    await h.restart().reconcile(drive.id, { graceMinutes: 0 });
    expect(pp.calls.filter((c) => isPayout(c.method, c.path)).map((c) => c.replayed)).toEqual([false, true]);
    expect(pp.payouts).toHaveLength(1);
    expect((await h.svc.getDriveView(drive.id)).payouts[0].attempts[0].status).toBe("confirmed");
  });
});

describe("crash around a capture", () => {
  for (const when of ["before", "after"] as When[]) {
    it(`${when} the third capture: each hold is captured exactly once`, async () => {
      const { pp, h } = await setup();
      const { drive } = await h.svc.createDemoDrive({ driveId: "demo-crash-cap" });
      await h.svc.submitReceipt({ driveId: drive.id, bytes: heroBytes() });
      await expect(h.restart(crashOn(pp.fetch, isCapture, when, 3)).captureNow(drive.id)).rejects.toThrow(/crash/);
      const svc = h.restart();
      // Within the grace period nothing is sent again; capture-now does not double either.
      await svc.captureNow(drive.id);
      expect(fresh(pp, isCapture)).toHaveLength(when === "before" ? 2 : 3);
      await svc.reconcile(drive.id, { graceMinutes: 0 });
      expect(fresh(pp, isCapture)).toHaveLength(4);
      const end = await svc.getDriveView(drive.id);
      for (const hold of end.holds) {
        const atPayPal = pp.captures.filter((c) => c.authorizationId === hold.authorizationId).reduce((a, c) => a + c.minor, 0);
        expect(hold.captured).toBe(atPayPal);
        expect(hold.capturePending).toBe(0);
      }
      expect(end.holds.map((x) => x.captured)).toEqual([458, 2145, 1237, 5224]);
    });
  }

  it("after the request, with PayPal's answer lost: the same request id brings back the same capture", async () => {
    const { pp, h } = await setup();
    const { drive } = await h.svc.createDemoDrive({ driveId: "demo-crash-cap-lost" });
    await h.svc.submitReceipt({ driveId: drive.id, bytes: heroBytes() });
    await expect(h.restart(crashOn(pp.fetch, isCapture, "after", 1)).captureNow(drive.id)).rejects.toThrow(/crash/);
    await h.db.db.delete(paypalCalls).where(eq(paypalCalls.requestId, `cap:${drive.id}:${drive.id}.water:1`));
    await h.restart().reconcile(drive.id, { graceMinutes: 0 });
    const water = pp.calls.filter((c) => isCapture(c.method, c.path) && c.requestId === `cap:${drive.id}:${drive.id}.water:1`);
    expect(water.map((c) => c.replayed)).toEqual([false, true]);
    expect(pp.captures).toHaveLength(4);
    expect((await h.svc.getDriveView(drive.id)).holds[0]).toMatchObject({ captured: 458, capturePending: 0 });
  });

  it("a stale pending capture is sent again only after the grace period, under the same request id", async () => {
    const { pp, h } = await setup();
    const { drive } = await h.svc.createDemoDrive({ driveId: "demo-stale" });
    await h.svc.submitReceipt({ driveId: drive.id, bytes: heroBytes() });
    await expect(h.restart(crashOn(pp.fetch, isCapture, "before", 1)).captureNow(drive.id)).rejects.toThrow(/crash/);
    const svc = h.restart();
    await svc.reconcile(drive.id); // default grace: 10 minutes, nothing is due yet
    expect(fresh(pp, isCapture)).toHaveLength(0);
    h.clock.advance(11 * 60_000);
    await svc.reconcile(drive.id);
    expect(fresh(pp, isCapture)).toHaveLength(4);
    expect(new Set(pp.captures.map((c) => c.requestId)).size).toBe(4);
  });
});

describe("crash around a void at close", () => {
  for (const when of ["before", "after"] as When[]) {
    it(`${when} the second void: closing again voids each hold once and the drive closes`, async () => {
      const { pp, h } = await setup();
      const { drive } = await h.svc.createDemoDrive({ driveId: "demo-crash-void" });
      await h.svc.submitReceipt({ driveId: drive.id, bytes: heroBytes() });
      await h.svc.captureNow(drive.id);
      await h.svc.reconcile(drive.id, { graceMinutes: 0 });
      await expect(h.restart(crashOn(pp.fetch, isVoid, when, 2)).closeDrive(drive.id)).rejects.toThrow(/crash/);
      expect((await h.svc.getDriveView(drive.id)).drive.status).toBe("closing");
      await h.restart().closeDrive(drive.id);
      const end = await h.svc.getDriveView(drive.id);
      expect(end.drive.status).toBe("closed");
      expect(pp.voids).toHaveLength(4);
      expect(end.closeReport.every((c) => c.settled)).toBe(true);
    });
  }
});
