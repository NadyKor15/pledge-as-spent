import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { drives, events } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// Attacks on the money path that the other suites do not cover, through the
// service's real write path. docs/red-team.md lists all 30 with their tests.

async function setup(driveId = "demo-redteam") {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  const ev = async (type: string) => (await h.db.db.select().from(events).where(eq(events.driveId, driveId))).filter((e) => e.type === type);
  const noMoney = async () => {
    expect(await ev("LineFunded")).toEqual([]);
    expect(pp.captures).toEqual([]);
    expect(pp.payouts).toEqual([]);
  };
  return { pp, rec, h, driveId, ev, noMoney };
}

const water = (qty: number, amount: number, over: Partial<SyntheticLine> = {}): SyntheticLine => ({ needId: "water", qty, amount, ...over });

/** The book's own view of the holds: nothing may ever exceed what a donor authorized. */
async function holdsWithinPledges(s: Awaited<ReturnType<typeof setup>>) {
  const v = await s.h.svc.getDriveView(s.driveId);
  for (const h of v.holds) expect(h.captured + h.capturePending + h.accrued).toBeLessThanOrEqual(h.authorized);
  return v;
}

describe("red team: the receipt lies", () => {
  it("a receipt with no purchase date moves no money", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 301, [water(2, 216)], { purchasedAt: null as never });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("review");
    await s.noMoney();
  });

  it("a receipt in another currency than the drive moves no money", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 302, [water(2, 216)], { currency: "USD" });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("rejected");
    await s.noMoney();
  });

  it("lines that do not add up to the printed total move no money", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 303, [water(2, 216)], { totalMinor: 100, subtotalMinor: 100 });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("review");
    await s.noMoney();
  });

  it("a negative line cannot pay for a bigger one on the same receipt", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 304, [water(2, 2000), water(1, -1800)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    const v = await holdsWithinPledges(s);
    expect((await s.ev("LineFunded")).length).toBeLessThanOrEqual(1);
    expect(s.pp.payouts.reduce((a, p) => a + p.minor, 0)).toBeLessThanOrEqual(200);
    expect(v.drive.status).toBe("open");
  });

  it("a line far above every pledge pays only what the holds cover", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 305, [water(40, 5_000_000)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    await holdsWithinPledges(s);
    const paid = s.pp.payouts.reduce((a, p) => a + p.minor, 0);
    expect(paid).toBeLessThanOrEqual(2 * 3247); // Lena's €20 in yen, doubled by the 1:1 match
  });

  it("more units than the need still lacks: the rest is refused as need_covered", async () => {
    const s = await setup();
    const a = syntheticReceipt(s.rec, 306, [water(38, 760)]);
    const b = syntheticReceipt(s.rec, 307, [water(10, 200)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: a.bytes });
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: b.bytes });
    const v = await holdsWithinPledges(s);
    expect(v.needs.find((n) => n.needId === "water")).toMatchObject({ qtyCovered: 40 });
  });

  it("the classifier names a need the drive does not have: nothing is funded for it", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 308, [{ needId: "rice", qty: 1, amount: 500 }]);
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("rejected");
    await s.noMoney();
  });

  it("the same receipt on two real drives pays once", async () => {
    const s = await setup("drive-one");
    await s.h.svc.createDemoDrive({ driveId: "drive-two" });
    await s.h.db.db.update(drives).set({ demo: false });
    const r = syntheticReceipt(s.rec, 309, [water(2, 216)]);
    expect((await s.h.svc.submitReceipt({ driveId: "drive-one", bytes: r.bytes })).receipt.status).toBe("funded");
    const second = await s.h.svc.submitReceipt({ driveId: "drive-two", bytes: r.bytes });
    expect(second.receipt.status).toBe("review");
    expect(second.receipt.flags.map((f) => f.code)).toContain("duplicate");
  });
});

describe("red team: buttons pressed at the wrong moment", () => {
  it("capture now pressed five times at once: one batch per hold, nothing charged twice", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 310, [water(2, 216)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    const before = s.pp.captures.length;
    await Promise.allSettled(Array.from({ length: 5 }, () => s.h.svc.captureNow(s.driveId)));
    const ids = s.pp.captures.map((c) => c.invoiceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.pp.captures.length).toBeGreaterThanOrEqual(before);
    await holdsWithinPledges(s);
  });

  it("the same flagged receipt approved twice at once funds it once", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 311, [water(2, 216)], { purchasedAt: "2020-01-01T10:00:00" });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("review");
    const results = await Promise.allSettled([
      s.h.svc.coordinatorDecision(out.receipt.id, "approve", "checked by phone"),
      s.h.svc.coordinatorDecision(out.receipt.id, "approve", "checked by phone"),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await s.ev("LineFunded")).toHaveLength(1);
    expect(s.pp.payouts).toHaveLength(1);
  });

  it("a flagged receipt whose lines are all refused stays unpaid after the approval and does not read as funded", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 313, [water(2, 216)], { currency: "USD", purchasedAt: "2020-01-01T10:00:00" });
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(out.receipt.status).toBe("review");
    const d = await s.h.svc.coordinatorDecision(out.receipt.id, "approve", "checked by phone");
    expect(d.receipt.status).toBe("rejected");
    await s.noMoney();
  });

  it("a receipt racing the close: either funded before it or refused, never funded on a closing drive", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 312, [water(2, 216)]);
    const [up] = await Promise.allSettled([s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes }), s.h.svc.closeDrive(s.driveId)]);
    if (up.status === "rejected") expect(up.reason).toBeInstanceOf(ServiceError);
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 });
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 });
    const v = await holdsWithinPledges(s);
    for (const h of v.holds) expect(h.captured + h.released + (h.uncollected ?? 0) + (h.reversed ?? 0)).toBe(h.authorized);
  });

  it("revoking twice and revoking after the close change nothing more", async () => {
    const s = await setup();
    const id = `${s.driveId}.water`;
    await s.h.svc.revokePledge(id);
    await Promise.allSettled([s.h.svc.revokePledge(id), s.h.svc.revokePledge(id)]);
    expect(s.pp.voids.filter((v) => v).length).toBeLessThanOrEqual(1);
    await s.h.svc.closeDrive(s.driveId);
    await s.h.svc.reconcile(s.driveId, { graceMinutes: 0 });
    await Promise.allSettled([s.h.svc.revokePledge(id)]);
    await holdsWithinPledges(s);
  });
});
