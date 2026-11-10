import path from "node:path";
import { describe, expect, it } from "vitest";
import { openPglite } from "../../src/db/client";
import { events } from "../../src/db/schema";
import { reportedFee, reportedFees } from "../../src/server/reported-fee";
import { feeLine } from "../../src/ui/fee-line";

// Point 6 of the review: "Pledge-as-Spent fee: 0 % · PayPal's fee on your share: €0.51". The amount is what PayPal
// reported (paypal_fee of each capture, recorded on CaptureConfirmed); a capture without one is "not reported by PayPal",
// never an estimate. Three currencies, as the showcase has them (EUR Lena, USD Mark, JPY Yuki).

const ROOT = path.resolve(__dirname, "../..");
const DRIVE = "demo-fees";

async function book(confirmed: { pledgeId: string; fee?: { currency: string; minor: number } }[]) {
  const h = await openPglite();
  await h.migrate(path.join(ROOT, "drizzle"));
  let seq = 0;
  for (const c of confirmed) {
    seq += 1;
    const payload = { type: "CaptureConfirmed", at: "2026-11-09T04:46:21.000Z", pledgeId: c.pledgeId, requestId: `r${seq}`, captureId: `CAP${seq}`, amount: { currency: c.fee?.currency ?? "EUR", minor: 100 }, ...(c.fee ? { paypalFee: c.fee } : {}) };
    await h.db.insert(events).values({ id: `e${seq}`, driveId: DRIVE, seq, at: payload.at, type: "CaptureConfirmed", source: "webhook", payload });
  }
  // Another drive's capture of the same pledge id is not this drive's.
  await h.db.insert(events).values({ id: "other", driveId: "other-drive", seq: 1, at: "2026-11-09T04:46:21.000Z", type: "CaptureConfirmed", source: "webhook", payload: { type: "CaptureConfirmed", pledgeId: "lena", requestId: "x", captureId: "X", amount: { currency: "EUR", minor: 1 }, paypalFee: { currency: "EUR", minor: 999 } } });
  return h.db;
}

const holds = [
  { pledgeId: "lena", currency: "EUR" },
  { pledgeId: "mark", currency: "USD" },
  { pledgeId: "yuki", currency: "JPY" },
  { pledgeId: "anna", currency: "EUR" },
];

describe("reportedFees", () => {
  it("sums what PayPal reported per donor, in the hold's currency: EUR, USD and JPY", async () => {
    const db = await book([
      { pledgeId: "lena", fee: { currency: "EUR", minor: 51 } },
      { pledgeId: "mark", fee: { currency: "USD", minor: 65 } },
      { pledgeId: "mark", fee: { currency: "USD", minor: 40 } },
      { pledgeId: "yuki", fee: { currency: "JPY", minor: 78 } },
    ]);
    const f = await reportedFees(db, DRIVE, holds);
    expect(f.lena).toEqual({ currency: "EUR", minor: 51, captures: 1, reported: 1 });
    expect(f.mark).toEqual({ currency: "USD", minor: 105, captures: 2, reported: 2 });
    expect(f.yuki).toEqual({ currency: "JPY", minor: 78, captures: 1, reported: 1 });
    expect(f.anna).toEqual({ currency: "EUR", minor: 0, captures: 0, reported: 0 });
    expect(feeLine(f.lena)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: €0.51");
    expect(feeLine(f.mark)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: $1.05");
    expect(feeLine(f.yuki)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: ¥78");
    expect(feeLine(f.anna)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: none, nothing captured yet");
  });

  it("a capture PayPal reported no fee for is not filled in: not reported, or reported for some captures only", async () => {
    const db = await book([{ pledgeId: "lena" }, { pledgeId: "mark", fee: { currency: "USD", minor: 65 } }, { pledgeId: "mark" }, { pledgeId: "yuki", fee: { currency: "EUR", minor: 5 } }]);
    const f = await reportedFees(db, DRIVE, holds);
    expect(f.lena).toEqual({ currency: "EUR", minor: 0, captures: 1, reported: 0 });
    expect(feeLine(f.lena)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: not reported by PayPal");
    expect(feeLine(f.mark)).toBe("Pledge-as-Spent fee: 0 % · PayPal’s fee on your share: $0.65 (reported by PayPal for 1 of 2 captures)");
    // A fee in another currency than the hold's is not this hold's fee: not reported.
    expect(f.yuki).toEqual({ currency: "JPY", minor: 0, captures: 1, reported: 0 });
  });

  it("one hold, and no line at all when the fees could not be read", async () => {
    const db = await book([{ pledgeId: "lena", fee: { currency: "EUR", minor: 51 } }]);
    expect(await reportedFee(db, DRIVE, "lena", "EUR")).toEqual({ currency: "EUR", minor: 51, captures: 1, reported: 1 });
    expect(feeLine(null)).toBeNull();
    expect(feeLine(undefined)).toBeNull();
  });
});
