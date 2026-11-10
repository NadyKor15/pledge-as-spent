// Live run of a hold's renewal in Nadezhda's PayPal sandbox, through the app's
// service layer (PGlite in memory, recorded receipt reading, no model call):
//   1. the Kitasora demo drive: holds in EUR, USD and JPY with the sandbox test card;
//   2. the sample receipt: Lena's hold pays its share of water;
//   3. Lena renews: a NEW order for what her hold has not promised, approved with the
//      test card (a real donor approves in the PayPal window); the book links the two;
//   4. the old hold captures what it owes and is voided; the new one holds the rest,
//      29 days from its own approval. Both are read back at PayPal (GET);
//   5. a second press is refused by the book without a PayPal call;
//   6. close: captures, voids, every hold settled; across the chain Lena is charged
//      no more than she pledged.
// Writes evidence/renew-sandbox-<UTC>.json with every PayPal id and status.
//
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx tsx scripts/renew-sandbox.ts

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { closeReport, promised, replay, type LedgerEvent } from "../src/core";
import { openPglite } from "../src/db/client";
import { events } from "../src/db/schema";
import { createPayPalGateway } from "../src/paypal/gateway";
import type { FetchLike } from "../src/paypal/recording";
import { Recordings } from "../src/receipts/recorded";
import { ServiceError } from "../src/server/errors";
import { PledgeService } from "../src/server/service";

const ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(ROOT, "evidence");
const VOLUNTEER = "sb-pywsi53523660@personal.example.com";
const CALL_BUDGET = 70;
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
    ipHashKey: `renew-${runId}`,
    renewEnabled: true,
    log: (m, x) => console.log(`  log: ${m}`, x ?? ""),
  });
  const driveId = `demo-rn-${randomBytes(4).toString("hex")}`;
  const steps: Record<string, unknown>[] = [];
  const note = (step: string, data: Record<string, unknown> = {}) => {
    const row = { step, at: new Date().toISOString(), calls, ...data };
    steps.push(row);
    console.log(JSON.stringify(row));
  };
  const book = async () => replay((await db.db.select().from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.seq))).map((e) => e.payload as LedgerEvent));
  const auth = async (id: string) => {
    const a = await gw.getAuthorization(id);
    return { id: a.id, status: a.status, amount: a.amount, expirationTime: a.expirationTime };
  };

  // 1. the drive and its holds
  const view = await svc.createDemoDrive({ driveId });
  note("holds", { holds: view.holds.map((h) => ({ pledgeId: h.pledgeId, donor: h.donorName, currency: h.currency, authorized: h.authorized, status: h.status, authorizationId: h.authorizationId, expiresAt: h.expiresAt })) });
  const lena = `${driveId}.water`;

  // 2. the sample receipt
  const out = await svc.submitReceipt({ driveId, bytes: new Uint8Array(readFileSync(path.join(ROOT, "eval/receipts/hero/hero-ja-01.png"))) });
  note("receipt", { receiptId: out.receipt.id, status: out.receipt.status, commands: out.commands.map((c) => ({ kind: c.kind, outcome: c.outcome, ids: c.ids })) });
  let s = await book();
  const lenaHold = s.holds[lena];
  const lenaAuthId = lenaHold.authorizationIds[0];
  note("lena before", { authorized: lenaHold.authorized, accrued: lenaHold.accrued, captured: lenaHold.captured, rest: lenaHold.authorized - promised(lenaHold), atPayPal: await auth(lenaAuthId) });

  // 3. Lena renews
  const callsBefore = calls;
  const renewed = await svc.renewPledge(lena);
  note("renew", { result: renewed, paypalCallsByRenew: calls - callsBefore });
  if (renewed.status !== "authorized") throw new Error(`the renewal is ${renewed.status}`);

  // 4. the old hold settles: its capture confirmed by lookup, then the void
  for (let i = 0; i < 12; i++) {
    await svc.reconcile(driveId, { graceMinutes: 0 });
    s = await book();
    if (s.pledges[lena].status === "voided") break;
    await sleep(5000);
  }
  const oldHold = s.holds[lena];
  const newHold = s.holds[renewed.pledgeId];
  note("linked", {
    old: { status: s.pledges[lena].status, renewedTo: oldHold.renewedTo, captured: oldHold.captured, released: oldHold.released, expiresAt: s.pledges[lena].expiresAt },
    renewal: { status: s.pledges[renewed.pledgeId].status, renews: s.pledges[renewed.pledgeId].renews, authorized: newHold.authorized, usable: newHold.usable, surplus: newHold.surplus, expiresAt: s.pledges[renewed.pledgeId].expiresAt, authorizationId: newHold.authorizationIds[0] },
    oldAtPayPal: await auth(lenaAuthId),
    renewalAtPayPal: await auth(newHold.authorizationIds[0]),
  });

  // 5. a second press: the book refuses it, PayPal is not asked
  const callsSecond = calls;
  const second = await svc.renewPledge(lena).then(
    (r) => ({ ok: true, r }),
    (e: unknown) => ({ ok: false, status: e instanceof ServiceError ? e.status : null, code: e instanceof ServiceError ? e.code : String(e), message: e instanceof Error ? e.message : String(e) }),
  );
  note("second press", { second, paypalCalls: calls - callsSecond });
  if (second.ok || calls !== callsSecond) throw new Error("a second press went through or asked PayPal");

  // 6. close and settle
  await svc.closeDrive(driveId);
  s = await book();
  for (let i = 0; i < 12 && s.drive!.status !== "closed"; i++) {
    await sleep(5000);
    await svc.reconcile(driveId, { graceMinutes: 0 });
    await svc.closeDrive(driveId).catch(() => []);
    s = await book();
  }
  const report = closeReport(s);
  const chain = report.filter((r) => r.pledgeId === lena || r.pledgeId === renewed.pledgeId);
  const lenaPledged = s.pledges[lena].amount.minor;
  const chainSpent = chain.reduce((a, r) => a + r.spent, 0);
  note("closed", { status: s.drive!.status, report, chain, lenaPledged, chainSpent });
  const finals = [];
  for (const id of s.pledgeIds) finals.push({ pledgeId: id, ...(await auth(s.holds[id].authorizationIds[0]).catch((e) => ({ error: String(e) }))) });
  note("holds at PayPal after close", { finals });
  if (chainSpent > lenaPledged) throw new Error(`the chain charged ${chainSpent} > pledged ${lenaPledged}`);

  const evidence = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox: "Nadezhda Korchagina's PayPal sandbox (Default Application APP-6EH18596R9530124Y), test card holds",
    driveId,
    paypalCalls: calls,
    renewal: { from: lena, to: renewed.pledgeId, orderId: renewed.orderId },
    chainChargedAtMostPledged: chainSpent <= lenaPledged,
    allSettled: report.every((r) => r.settled),
    closed: s.drive!.status === "closed",
    steps,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `renew-sandbox-${runId}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`evidence: ${path.relative(ROOT, file)}; settled ${evidence.allSettled}; closed ${evidence.closed}; chain ${chainSpent}/${lenaPledged}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
