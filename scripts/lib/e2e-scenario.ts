import type { FetchLike } from "../../src/paypal/recording";
import { ServiceError } from "../../src/server/errors";
import type { CommandReport, DriveView, PledgeService, ReceiptView } from "../../src/server/service";

// The judges' demo drive, step by step, through the service layer. The live
// e2e script (scripts/e2e-sandbox.ts) and the replay integration test run this
// same sequence, so the recorded sandbox exchanges replay strictly.

export const HERO = "eval/receipts/hero/hero-ja-01.png";
export const PRE_DISASTER = "eval/receipts/adversarial/adv-predisaster-ja.png";

export interface ScenarioIo {
  /** Builds a service over the shared database with this PayPal fetch: a new one is a process restart. */
  make(fetch: FetchLike): PledgeService;
  fetch: FetchLike;
  driveId: string;
  read(relPath: string): Uint8Array;
  /** Live: sleep; replay: move the clock. */
  wait(ms: number): Promise<void>;
  onStep?(name: string, note: string): void;
}

export interface ScenarioResult {
  driveId: string;
  walletPledgeId: string;
  created: DriveView;
  wallet: { pledgeId: string; orderId: string; approveUrl: string | null; status: string };
  authorizeBeforeApproval: string;
  hero: { receipt: ReceiptView; commands: CommandReport[] };
  duplicate: ReceiptView;
  preDisaster: ReceiptView;
  crash: string;
  /** Distinct capture requests that left before the crash. */
  capturesBeforeCrash: number;
  lookups: CommandReport[][];
  close: CommandReport[];
  final: DriveView;
}

export async function runScenario(io: ScenarioIo): Promise<ScenarioResult> {
  const step = (name: string, note: string) => io.onStep?.(name, note);
  // The crash: CaptureSubmitted is committed, then the process dies before the Nth capture request leaves.
  let crashAt = 0;
  let captureRequests = 0;
  const crashing: FetchLike = (url, init) => {
    if (init.method === "POST" && url.endsWith("/capture") && crashAt > 0) {
      captureRequests += 1;
      if (captureRequests === crashAt) throw new Error("simulated crash before the capture request was sent");
    }
    return io.fetch(url, init);
  };
  let svc = io.make(crashing);
  const driveId = io.driveId;
  const walletPledgeId = `${driveId}.wallet`;

  step("demo-drive", "fresh demo drive: three donor holds and a 1:1 company match, sandbox test card");
  const created = await svc.createDemoDrive({ ip: "e2e", driveId });

  step("wallet-pledge", "a donor pledge through the PayPal window: AUTHORIZE order with user_action PAY_NOW");
  const wallet = await svc.createPledge({ driveId, needId: "water", donorName: "Claire (Lyon)", donorCountry: "FR", amount: { currency: "EUR", minor: 1000 }, pledgeId: walletPledgeId });

  step("wallet-authorize-unapproved", "authorize before the donor approved: PayPal refuses, the book does not change");
  let authorizeBeforeApproval: string;
  try {
    const r = await svc.approvePledge(walletPledgeId, wallet.orderId);
    authorizeBeforeApproval = `unexpectedly ${r.status}`;
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    authorizeBeforeApproval = `${e.status} ${e.code}`;
  }

  step("hero-receipt", "the hero receipt: 9 lines funded, 2 refused, volunteer payout");
  const hero = await svc.submitReceipt({ driveId, bytes: io.read(HERO), ip: "e2e" });

  step("duplicate-receipt", "the same photo again: flagged as a duplicate, no money moves");
  const duplicate = (await svc.submitReceipt({ driveId, bytes: io.read(HERO), ip: "e2e" })).receipt;

  step("pre-disaster-receipt", "a receipt dated before the disaster: flagged, no money moves");
  const preDisaster = (await svc.submitReceipt({ driveId, bytes: io.read(PRE_DISASTER), ip: "e2e" })).receipt;

  step("capture-now-crash", "capture now; the process dies right before the second capture request leaves");
  crashAt = 2;
  let crash = "no crash happened";
  try {
    await svc.captureNow(driveId);
  } catch (e) {
    crash = (e as Error).message;
  }
  const capturesBeforeCrash = captureRequests - 1;
  crashAt = 0;

  step("restart-lookup", "new process: captures PayPal never answered go out again under the same request ids; GET each capture and the payout");
  svc = io.make(io.fetch);
  await io.wait(1_000);
  const lookups = [await svc.reconcile(driveId, { graceMinutes: 0 })];
  for (let i = 0; i < 6; i++) {
    const v = await svc.getDriveView(driveId);
    if (v.payouts.every((p) => p.attempts.some((a) => a.status === "confirmed"))) break;
    await io.wait(10_000);
    step(`payout-lookup-${i + 1}`, "the payout is still in progress at PayPal: look again");
    lookups.push(await svc.reconcile(driveId, { graceMinutes: 0 }));
  }

  step("close", "close: everything is captured, so each hold's remainder is voided and the drive closes");
  const close = await svc.closeDrive(driveId);
  const final = await svc.getDriveView(driveId);
  return { driveId, walletPledgeId, created, wallet, authorizeBeforeApproval, hero, duplicate, preDisaster, crash, capturesBeforeCrash, lookups, close, final };
}
