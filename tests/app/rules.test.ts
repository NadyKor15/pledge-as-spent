import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../../src/server/errors";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt, type SyntheticLine } from "./support/synthetic";

// Donor rules per line (DONOR_RULES): "only these needs" and "at most X per unit" in the
// donor's currency. A line is split only between holds whose rules allow it; the donor's
// statement lists the lines their rules kept the hold out of.

vi.setConfig({ testTimeout: 60_000 });

const L = (needId: string, qty: number, amount: number): SyntheticLine => ({ needId, qty, amount });

async function setup(driveId: string) {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  const pledge = async (rules: unknown) => {
    const p = await h.svc.createPledge({ driveId, needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR", minor: 1000 }, rules: rules as never });
    pp.approve(p.orderId);
    await h.svc.approvePledge(p.pledgeId, p.orderId);
    return p.pledgeId;
  };
  return { pp, rec, h, driveId, pledge };
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

describe("donor rules switched off", () => {
  it("ignores them exactly as before the feature existed", async () => {
    vi.stubEnv("DONOR_RULES", "");
    const s = await setup("demo-rules-off");
    const id = await s.pledge({ maxUnitMinor: 1 });
    const hold = (await s.h.svc.getDriveView(s.driveId)).holds.find((h) => h.pledgeId === id)!;
    expect("rules" in hold).toBe(false);
    expect((await s.h.svc.getDriveView(s.driveId)).features).toMatchObject({ rules: false });
    expect("ruledOut" in (await s.h.svc.getStatement(id)).statement).toBe(false);
  });
});

describe("donor rules switched on", () => {
  it("keeps a capped hold out of a dearer line, pays it from the others, and tells the donor which line and why", async () => {
    vi.stubEnv("DONOR_RULES", "1");
    const s = await setup("demo-rules");
    const claire = await s.pledge({ maxUnitMinor: 60 }); // at most €0.60 a bottle = ¥97.41
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 901, [L("water", 4, 432)]).bytes }); // ¥108 a bottle
    expect(out.receipt.status).toBe("funded");
    const view = await s.h.svc.getDriveView(s.driveId);
    const water = view.ledger.filter((r) => r.receiptId === out.receipt.id && r.kind === "donor_share");
    expect(water.map((r) => r.pledgeId)).toEqual([`${s.driveId}.water`]); // Lena alone, never Claire
    expect(view.holds.find((h) => h.pledgeId === claire)).toMatchObject({ rules: { maxUnitMinor: 60 }, accrued: 0, captured: 0 });
    const st = (await s.h.svc.getStatement(claire)).statement;
    expect(st.ruledOut).toEqual([{ receiptId: out.receipt.id, lineNo: 1, needId: "water", qty: 4, amountBase: 432, unitQuote: 67, reason: "price" }]);
    // a cheaper line: Claire pays her share
    const cheap = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 902, [L("water", 10, 900)]).bytes }); // ¥90 a bottle
    const shares = (await s.h.svc.getDriveView(s.driveId)).ledger.filter((r) => r.receiptId === cheap.receipt.id && r.kind === "donor_share").map((r) => r.pledgeId).sort();
    expect(shares).toEqual([claire, `${s.driveId}.water`].sort());
  });

  it("refuses rules that cannot hold, before PayPal is asked", async () => {
    vi.stubEnv("DONOR_RULES", "1");
    const s = await setup("demo-rules-bad");
    const calls = s.pp.calls.length;
    const base = { driveId: s.driveId, needId: "water", donorName: "X", amount: { currency: "EUR" as const, minor: 1000 } };
    expect(await reject(s.h.svc.createPledge({ ...base, rules: { needs: ["water", "rice"] } }))).toMatchObject({ status: 400, code: "invalid_pledge" });
    expect(await reject(s.h.svc.createPledge({ ...base, rules: { needs: ["diapers"] } }))).toMatchObject({ status: 400, message: expect.stringMatching(/own need/) });
    expect(await reject(s.h.svc.createPledge({ ...base, rules: { maxUnitMinor: -5 } }))).toMatchObject({ status: 400, code: "invalid_rules" });
    expect(await reject(s.h.svc.createPledge({ ...base, rules: { needs: "water" } }))).toMatchObject({ status: 400, code: "invalid_rules" });
    expect(s.pp.calls.length).toBe(calls);
  });
});
