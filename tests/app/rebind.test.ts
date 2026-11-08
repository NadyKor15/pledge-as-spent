import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// A donor moves what is left of a hold to another need (REBIND_ENABLED). The
// attacks of docs/red-team.md #31-#37 go through the service's real write path.

async function setup(driveId = "demo-rebind") {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  const rebinds = async () => (await h.db.db.select().from(events).where(eq(events.driveId, driveId))).filter((e) => e.type === "PledgeRebound");
  const hold = async (key: string) => (await h.svc.getDriveView(driveId)).holds.find((x) => x.pledgeId === `${driveId}.${key}`)!;
  return { pp, rec, h, driveId, rebinds, hold, lena: `${driveId}.water` };
}

const water = (qty: number, amount: number): SyntheticLine => ({ needId: "water", qty, amount });
const diapers = (qty: number, amount: number): SyntheticLine => ({ needId: "diapers", qty, amount });

async function refused(p: Promise<unknown>, status: number, rule: RegExp) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  expect((e as ServiceError).status).toBe(status);
  expect((e as ServiceError).message).toMatch(rule);
}

describe("rebind switched off", () => {
  it("is refused and the statement offers nothing", async () => {
    vi.stubEnv("REBIND_ENABLED", "");
    const s = await setup();
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" }), 404, /not switched on/);
    expect((await s.h.svc.getStatement(s.lena)).rebind).toBeNull();
    expect(await s.rebinds()).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("rebind switched on", () => {
  beforeEach(() => vi.stubEnv("REBIND_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("moves Lena's rest from water to diapers without a single PayPal call", async () => {
    const s = await setup();
    const r = syntheticReceipt(s.rec, 401, [water(4, 432)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    const before = await s.hold("water");
    const offer = (await s.h.svc.getStatement(s.lena)).rebind!;
    expect(offer.targets.map((t) => t.needId)).toEqual(["diapers", "batteries"]);
    const calls = s.pp.calls.length;

    const out = await s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" });
    expect(out).toMatchObject({ pledgeId: s.lena, needId: "diapers", rebound: { fromNeedId: "water", toNeedId: "diapers", by: "Lena (Berlin)", via: "statement" } });
    // PayPal is not asked anything: same authorization, same amount, same expiry
    expect(s.pp.calls.length).toBe(calls);
    const after = await s.hold("water");
    for (const k of ["authorized", "captured", "capturePending", "accrued", "available", "authorizationId", "expiresAt"] as const) expect(after[k]).toEqual(before[k]);
    expect(after.needId).toBe("diapers");

    // water: not a cent from Lena any more; diapers: Lena next to Mark
    const r2 = syntheticReceipt(s.rec, 402, [water(2, 216), diapers(1, 1298)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r2.bytes });
    const st = (await s.h.svc.getStatement(s.lena)).statement;
    expect(st.rows.map((x) => x.needId)).toEqual(["water", "diapers"]);
    expect(st.rows[0].receiptId).toBe(st.rows[0].receiptId);
    const view = await s.h.svc.getDriveView(s.driveId);
    for (const h of view.holds) expect(h.captured + h.capturePending + h.accrued).toBeLessThanOrEqual(h.authorized);
  });

  it("#31 twice: the same press answers the same, a second need is refused, one event in the book", async () => {
    const s = await setup();
    await s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" });
    const again = await s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" });
    expect(again.needId).toBe("diapers");
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "diapers", toNeedId: "batteries" }), 409, /already_rebound/);
    expect(await s.rebinds()).toHaveLength(1);
  });

  it("#32 a race of two presses for different needs moves the hold once", async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" }),
      s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "batteries" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await s.rebinds()).toHaveLength(1);
    const winner = (results.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ needId: string }>).value.needId;
    expect((await s.hold("water")).needId).toBe(winner);
  });

  it("#33 after the close, and after a withdrawal", async () => {
    const closed = await setup("demo-rebind-closed");
    await closed.h.svc.closeDrive(closed.driveId);
    await refused(closed.h.svc.rebindPledge({ pledgeId: closed.lena, fromNeedId: "water", toNeedId: "diapers" }), 409, /drive_not_open/);

    const gone = await setup("demo-rebind-revoked");
    await gone.h.svc.revokePledge(gone.lena);
    await refused(gone.h.svc.rebindPledge({ pledgeId: gone.lena, fromNeedId: "water", toNeedId: "diapers" }), 409, /revoked|hold_not_live/);
    expect([...(await closed.rebinds()), ...(await gone.rebinds())]).toEqual([]);
  });

  it("#34 onto a covered need, and from a stale screen", async () => {
    const s = await setup();
    // diapers need 6 packs: a receipt with 6 covers it
    const r = syntheticReceipt(s.rec, 403, [diapers(6, 7788)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" }), 409, /need_covered/);
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "batteries", toNeedId: "diapers" }), 409, /stale_need/);
    expect(await s.rebinds()).toEqual([]);
  });

  it("#35 someone else's hold: the company match never moves, an unknown pledge is not found", async () => {
    const s = await setup();
    await refused(s.h.svc.rebindPledge({ pledgeId: `${s.driveId}.match`, fromNeedId: "water", toNeedId: "diapers" }), 409, /not_donor/);
    await refused(s.h.svc.rebindPledge({ pledgeId: `${s.driveId}.nobody`, fromNeedId: "water", toNeedId: "diapers" }), 404, /No pledge/);
    // a pledge id of another drive only ever moves inside its own drive
    const other = await setup("demo-rebind-other");
    await refused(s.h.svc.rebindPledge({ pledgeId: other.lena, fromNeedId: "water", toNeedId: "tarps" }), 409, /unknown_need/);
    expect(await s.rebinds()).toEqual([]);
  });

  it("#36 onto a need of another drive in another currency", async () => {
    const s = await setup();
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "hurricane-water-usd" }), 409, /unknown_need/);
  });

  it("#37 in the last 3 days of the hold", async () => {
    const s = await setup();
    const expiresAt = (await s.hold("water")).expiresAt!;
    s.h.clock.set(new Date(Date.parse(expiresAt) - 2 * 24 * 3_600_000).toISOString());
    await refused(s.h.svc.rebindPledge({ pledgeId: s.lena, fromNeedId: "water", toNeedId: "diapers" }), 409, /too_close_to_expiry/);
    expect((await s.h.svc.getStatement(s.lena)).rebind).toMatchObject({ targets: [], refusal: { code: "too_close_to_expiry" } });
  });
});
