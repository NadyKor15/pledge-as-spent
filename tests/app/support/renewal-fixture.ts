import { eq } from "drizzle-orm";
import { FAKE_EPOCH, fakeSandbox } from "./fake-sandbox";
import { harness, loadRecordings } from "./harness";
import { syntheticReceipt } from "./synthetic";
import { DAY_MS } from "../../../src/core";
import { drives } from "../../../src/db/schema";

// A drive view with ONE renewed donor, made by the real service (fake sandbox, PGlite).
// The Kitasora demo drive; water 10 bottles for ¥1,080 (Lena's share €3.33); on day 27
// Lena renews; PayPal confirms her capture and her old hold is voided. The view then
// holds two holds for Lena: the old one (voided, renewedTo = the new id) and the new one
// (renews = the old id, usable = what it carried on). Screens count Lena once
// (src/ui/renewal-chain.ts: groupByChain, then mergeChain for anything that reads a hold).
//
// Stages, Lena's chain in euro cents (what she pledged: 2000):
//   "renewed"  old: captured 333, released 1667, voided; new: authorized 1667, usable 1667, live
//   "captured" + a second water line on day 28, captured from the new hold (333)
//   "closed"   + the drive closed: the new hold voided, its rest never charged
//   "race"     a real drive: Lena presses Renew for all €20.00, a water line takes €3.33 from
//              her old hold while she is in PayPal, then she approves: the new hold is
//              authorized 2000, usable 1667, surplus 333 (held at PayPal, never promised)

export type RenewedStage = "renewed" | "captured" | "closed" | "race";

export interface RenewedDrive {
  view: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["svc"]["getDriveView"]>>;
  /** Lena's first hold and her renewal. */
  lena: string;
  renewal: string;
  /** The other donors and the match: no renewals. */
  others: string[];
}

export async function renewedDrive(stage: RenewedStage = "renewed", driveId = `demo-renewed-${stage}`): Promise<RenewedDrive> {
  const before = process.env.RENEW_ENABLED;
  process.env.RENEW_ENABLED = "1";
  try {
    let now: () => string = () => FAKE_EPOCH;
    const pp = fakeSandbox({ now: () => now() });
    const rec = loadRecordings();
    const h = await harness({ fetch: pp.fetch, recordings: rec });
    now = () => h.clock.now();
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        h.clock.advance(60_000);
        await h.svc.reconcile(driveId, { graceMinutes: 0 });
      }
    };
    await h.svc.createDemoDrive({ driveId });
    const lena = `${driveId}.water`;
    let renewal: string;
    if (stage === "race") {
      await h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, driveId));
      const r = await h.svc.renewPledge(lena); // all €20.00, waiting for Lena in PayPal
      await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 701, [{ needId: "water", qty: 10, amount: 1080 }]).bytes });
      pp.approve(r.orderId);
      await h.svc.approvePledge(r.pledgeId, r.orderId);
      await settle();
      renewal = r.pledgeId;
    } else {
      await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 701, [{ needId: "water", qty: 10, amount: 1080 }]).bytes });
      h.clock.advance(27 * DAY_MS);
      renewal = (await h.svc.renewPledge(lena)).pledgeId;
      await settle();
      if (stage === "captured" || stage === "closed") {
        h.clock.advance(DAY_MS);
        await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 702, [{ needId: "water", qty: 10, amount: 1080 }]).bytes });
        await h.svc.captureNow(driveId);
        await settle();
      }
      if (stage === "closed") {
        await h.svc.closeDrive(driveId);
        await settle();
      }
    }
    const view = await h.svc.getDriveView(driveId);
    return { view, lena, renewal, others: view.holds.map((x) => x.pledgeId).filter((x) => x !== lena && x !== renewal) };
  } finally {
    if (before === undefined) delete process.env.RENEW_ENABLED;
    else process.env.RENEW_ENABLED = before;
  }
}
