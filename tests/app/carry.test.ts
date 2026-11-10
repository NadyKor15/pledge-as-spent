import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestCarried } from "../../src/core";
import { events } from "../../src/db/schema";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// The donor's choice at the pledge: "keep the rest for this drive's next
// purchases" (REBIND_ENABLED). Once the need is covered, the rest of the hold
// backs the open need that lacks the most. No PayPal call; one event per move.

// Each test opens a drive in PGlite and runs several receipts: slow on a loaded machine, not a hang.
vi.setConfig({ testTimeout: 60_000 });

async function setup(driveId = "demo-carry") {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  const carries = async () =>
    (await h.db.db.select().from(events).where(eq(events.driveId, driveId)))
      .filter((e) => e.type === "RestCarried")
      .map((e) => ({ source: e.source, payload: e.payload as RestCarried }));
  const hold = async (pledgeId: string) => (await h.svc.getDriveView(driveId)).holds.find((x) => x.pledgeId === pledgeId)!;
  /** A donor pledge approved in the (fake) PayPal window. */
  const pledge = async (name: string, needId: string, currency: "EUR" | "USD" | "JPY", minor: number, rest?: string) => {
    const p = await h.svc.createPledge({ driveId, needId, donorName: name, amount: { currency, minor }, rest });
    pp.approve(p.orderId);
    await h.svc.approvePledge(p.pledgeId, p.orderId);
    return p.pledgeId;
  };
  return { pp, rec, h, driveId, carries, hold, pledge };
}

const L = (needId: string, qty: number, amount: number): SyntheticLine => ({ needId, qty, amount });

async function reject(p: Promise<unknown>): Promise<ServiceError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

describe("carry switched off", () => {
  beforeEach(() => vi.stubEnv("REBIND_ENABLED", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses the choice before PayPal is asked, and the drive says the feature is off", async () => {
    const s = await setup();
    expect((await s.h.svc.getDriveView(s.driveId)).features).toEqual({ carry: false, renew: false });
    const calls = s.pp.calls.length;
    const base = { driveId: s.driveId, needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR" as const, minor: 1000 } };
    expect(await reject(s.h.svc.createPledge({ ...base, rest: "carry" }))).toMatchObject({ status: 400, code: "carry_disabled" });
    expect(await reject(s.h.svc.createPledge({ ...base, rest: "maybe" }))).toMatchObject({ status: 400, code: "invalid_rest" });
    expect(s.pp.calls.length).toBe(calls);
    // "release" is what every pledge did so far: accepted, nothing ever moves
    const id = await s.pledge("Claire (Lyon)", "water", "EUR", 1000, "release");
    expect((await s.hold(id)).rest).toBe("release");
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 501, [L("water", 40, 4320)]).bytes });
    expect(await s.carries()).toEqual([]);
  });

  it("switched off after a donor chose to keep the rest: nothing moves any more", async () => {
    vi.stubEnv("REBIND_ENABLED", "1");
    const s = await setup();
    const claire = await s.pledge("Claire (Lyon)", "water", "EUR", 1000, "carry");
    vi.stubEnv("REBIND_ENABLED", "");
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 506, [L("water", 40, 4320)]).bytes });
    await s.h.svc.runDaily();
    expect(await s.carries()).toEqual([]);
    expect((await s.hold(claire)).needId).toBe("water");
  });
});

describe("carry switched on", () => {
  beforeEach(() => vi.stubEnv("REBIND_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("moves the rest between two lines of one receipt, so the next line already counts on it, without a PayPal call of its own", async () => {
    const s = await setup();
    expect((await s.h.svc.getDriveView(s.driveId)).features).toEqual({ carry: true, renew: false });
    const claire = await s.pledge("Claire (Lyon)", "water", "EUR", 1000, "carry");
    expect(await reject(s.h.svc.createPledge({ driveId: s.driveId, needId: null, match: { ratioNum: 1, ratioDen: 1 }, donorName: "Co", amount: { currency: "JPY", minor: 1000 }, rest: "carry" }))).toMatchObject({ code: "invalid_rest" });
    const before = await s.hold(claire);

    // water 40 of 40 (covered), then a pack of diapers on the same receipt
    const r = syntheticReceipt(s.rec, 502, [L("water", 40, 4320), L("diapers", 1, 1298)]);
    const calls = s.pp.calls.length;
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });

    const moved = await s.carries();
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ source: "app", payload: { pledgeId: claire, fromNeedId: "water", toNeedId: "diapers", consent: { by: "Claire (Lyon)", via: "pledge_choice" } } });
    const after = await s.hold(claire);
    expect(after).toMatchObject({ needId: "diapers", rest: "carry", authorized: before.authorized, authorizationId: before.authorizationId, expiresAt: before.expiresAt });
    expect(after.carried).toEqual([{ at: moved[0].payload.at, fromNeedId: "water", toNeedId: "diapers" }]);

    // the diapers line drew on Claire's rest next to Mark
    const st = (await s.h.svc.getStatement(claire)).statement;
    expect(st.rows.map((x) => x.needId)).toEqual(["water", "diapers"]);
    // every PayPal call of this receipt is a payout or a capture: none is the carry's
    for (const c of s.pp.calls.slice(calls)) expect(c.path).toMatch(/payouts|capture/);
    const view = await s.h.svc.getDriveView(s.driveId);
    for (const h of view.holds) expect(h.captured + h.capturePending + h.accrued).toBeLessThanOrEqual(h.authorized);
  });

  it("moves a hold approved for a need that is already covered at once", async () => {
    const s = await setup();
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 503, [L("water", 40, 4320)]).bytes });
    expect(await s.carries()).toEqual([]);
    const late = await s.pledge("Ines (Porto)", "water", "EUR", 500, "carry");
    const moved = await s.carries();
    expect(moved.map((e) => [e.payload.pledgeId, e.payload.toNeedId])).toEqual([[late, "diapers"]]);
    expect((await s.hold(late)).needId).toBe("diapers");
  });

  it("does not move twice: the same receipt again, the daily job and a second approval add nothing", async () => {
    const s = await setup();
    const claire = await s.pledge("Claire (Lyon)", "water", "EUR", 1000, "carry");
    const r = syntheticReceipt(s.rec, 504, [L("water", 40, 4320)]);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes });
    expect(await s.carries()).toHaveLength(1);
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: r.bytes }); // a duplicate: held for the coordinator
    await s.h.svc.runDaily();
    await s.h.svc.approvePledge(claire); // a double click on the PayPal button's return
    expect(await s.carries()).toHaveLength(1);
  });

  it("carries holds in euros, dollars and yen alike, each in its own currency", async () => {
    const s = await setup();
    const ids = [await s.pledge("Claire (Lyon)", "water", "EUR", 1000, "carry"), await s.pledge("Sam (Denver)", "water", "USD", 1500, "carry"), await s.pledge("Aoi (Sendai)", "water", "JPY", 2000, "carry")];
    const before = await Promise.all(ids.map(s.hold));
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 505, [L("water", 40, 4320), L("diapers", 2, 2596)]).bytes });
    expect((await s.carries()).map((e) => e.payload.pledgeId).sort()).toEqual([...ids].sort());
    const after = await Promise.all(ids.map(s.hold));
    after.forEach((h, i) => {
      expect(h.needId).toBe("diapers");
      expect(h.currency).toBe(["EUR", "USD", "JPY"][i]);
      expect(h.authorized).toBe(before[i].authorized);
      expect(h.captured + h.capturePending + h.accrued).toBeLessThanOrEqual(h.authorized);
    });
    // the diapers line: shares in all three currencies plus Mark's and the match
    const rows = (await s.h.svc.getDriveView(s.driveId)).ledger.filter((x) => x.needId === "diapers" && x.kind === "donor_share");
    expect(new Set(rows.map((x) => x.currency))).toEqual(new Set(["EUR", "USD", "JPY"]));
  });
});
