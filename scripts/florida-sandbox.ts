// Live run of the Florida demo drive in Nadezhda's PayPal sandbox, through the
// app's service layer (PGlite in memory, recorded receipt reading, no model call):
//   1. five holds with the sandbox test card: EUR, JPY and USD on a USD drive;
//   2. a donor moves the rest of her hold to another need: the authorization is
//      read at PayPal before and after, and the move itself makes no PayPal call;
//   3. the sample receipt: lines funded, the volunteer paid in USD;
//   4. close: captures, voids, every donor settled.
// Writes evidence/florida-sandbox-<UTC>.json with every PayPal id and status.
//
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx tsx scripts/florida-sandbox.ts

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeReport, replay, type LedgerEvent } from "../src/core";
import { openPglite } from "../src/db/client";
import { events } from "../src/db/schema";
import { createPayPalGateway } from "../src/paypal/gateway";
import type { FetchLike } from "../src/paypal/recording";
import { Recordings } from "../src/receipts/recorded";
import { PledgeService } from "../src/server/service";
import { asc, eq } from "drizzle-orm";

const ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(ROOT, "evidence");
const VOLUNTEER = "sb-pywsi53523660@personal.example.com";
const CALL_BUDGET = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox app.");

  let calls = 0;
  const counted: FetchLike = (url, init) => {
    if (!url.includes("api-m.sandbox.paypal.com")) throw new Error(`refusing a non-sandbox host: ${new URL(url).host}`);
    if (!url.endsWith("/v1/oauth2/token") && ++calls > CALL_BUDGET) throw new Error(`call budget of ${CALL_BUDGET} exceeded`);
    return fetch(url, init);
  };
  const gw = createPayPalGateway({ clientId, clientSecret, fetch: counted });
  const db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  const recordings = Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")));
  const svc = new PledgeService({
    db: db.db,
    recordings,
    paypal: { clientId, clientSecret, fetch: counted, retryDelayMs: 1000 },
    webhookId: null,
    demoPayoutEmail: VOLUNTEER,
    ipHashKey: `florida-${runId}`,
    rebindEnabled: true,
    log: (m, x) => console.log(`  log: ${m}`, x ?? ""),
  });
  const driveId = `demo-fl-${randomBytes(4).toString("hex")}`;
  const steps: Record<string, unknown>[] = [];
  const note = (step: string, data: Record<string, unknown> = {}) => {
    const row = { step, at: new Date().toISOString(), calls, ...data };
    steps.push(row);
    console.log(JSON.stringify(row));
  };
  const book = async () => replay((await db.db.select().from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.seq))).map((e) => e.payload as LedgerEvent));

  // 1. the drive and its five holds
  const view = await svc.createDemoDrive({ driveId, scenario: "florida" });
  note("holds", { holds: view.holds.map((h) => ({ pledgeId: h.pledgeId, donor: h.donorName, currency: h.currency, authorized: h.authorized, status: h.status, authorizationId: h.authorizationId, expiresAt: h.expiresAt })) });

  // 2. Sofia moves the rest of her water hold to blankets
  const sofia = `${driveId}.water`;
  const sofiaAuth = view.holds.find((h) => h.pledgeId === sofia)!.authorizationId!;
  const before = await gw.getAuthorization(sofiaAuth);
  note("auth before", { id: before.id, status: before.status, amount: before.amount, expirationTime: before.expirationTime });
  const callsBefore = calls;
  const moved = await svc.rebindPledge({ pledgeId: sofia, fromNeedId: "water", toNeedId: "blankets" });
  const callsByMove = calls - callsBefore;
  note("rebind", { rebound: moved.rebound, paypalCallsByMove: callsByMove });
  const after = await gw.getAuthorization(sofiaAuth);
  note("auth after", { id: after.id, status: after.status, amount: after.amount, expirationTime: after.expirationTime });
  const same = before.status === after.status && JSON.stringify(before.amount) === JSON.stringify(after.amount) && before.expirationTime === after.expirationTime;
  if (!same || callsByMove !== 0) throw new Error(`the move changed something at PayPal: ${JSON.stringify({ before, after, callsByMove })}`);

  // 3. the sample receipt
  const t0 = Date.now();
  const out = await svc.submitReceipt({ driveId, bytes: new Uint8Array(readFileSync(path.join(ROOT, "eval/receipts/florida/florida-sample.png"))) });
  note("receipt", { receiptId: out.receipt.id, status: out.receipt.status, reader: out.receipt.reader, ms: Date.now() - t0, commands: out.commands.map((c) => ({ kind: c.kind, outcome: c.outcome, detail: c.detail, ids: c.ids })) });
  let payout: { senderBatchId: string; payoutBatchId?: string; status: string; amount: number } | null = null;
  for (let i = 0; i < 18; i++) {
    await svc.reconcile(driveId, { graceMinutes: 0 });
    const s = await book();
    const a = (s.payouts[out.receipt.id] ?? [])[0];
    payout = a ? { senderBatchId: a.senderBatchId, payoutBatchId: a.payoutBatchId, status: a.status, amount: a.amount } : null;
    if (a && a.status !== "pending") break;
    await sleep(5000);
  }
  note("payout", { payout });
  const batch = payout?.payoutBatchId ? await gw.getPayoutBatch(payout.payoutBatchId) : null;
  note("payout at PayPal", { batch });

  // 4. capture now, close, settle
  await svc.captureNow(driveId);
  for (let i = 0; i < 12; i++) {
    await svc.reconcile(driveId, { graceMinutes: 0 });
    const s = await book();
    if (Object.values(s.holds).every((h) => h.capturePending === 0)) break;
    await sleep(5000);
  }
  await svc.closeDrive(driveId);
  let s = await book();
  for (let i = 0; i < 12 && s.drive!.status !== "closed"; i++) {
    await sleep(5000);
    await svc.reconcile(driveId, { graceMinutes: 0 });
    await svc.closeDrive(driveId).catch(() => []);
    s = await book();
  }
  const report = closeReport(s);
  note("closed", { status: s.drive!.status, report });
  const finals = [];
  for (const id of s.pledgeIds) finals.push({ pledgeId: id, ...(await gw.getAuthorization(s.holds[id].authorizationIds[0]).then((a) => ({ status: a.status, amount: a.amount })).catch((e) => ({ error: String(e) }))) });
  note("holds at PayPal after close", { finals });

  const evidence = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox: "Nadezhda Korchagina's PayPal sandbox (Default Application APP-6EH18596R9530124Y), test card holds",
    driveId,
    paypalCalls: calls,
    rebindMadePayPalCalls: callsByMove,
    authorizationUnchangedByRebind: same,
    steps,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `florida-sandbox-${runId}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`evidence: ${path.relative(ROOT, file)}; settled ${report.every((r) => r.settled)}; closed ${s.drive!.status === "closed"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
