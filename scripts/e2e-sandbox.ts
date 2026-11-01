// Live end-to-end run of the judges' demo drive in Nadezhda's PayPal sandbox,
// through the app's service layer (PGlite in memory, recorded receipt readings,
// no model calls). Records every PayPal exchange (sanitized) as fixtures for the
// integration tests and writes evidence/e2e-<UTC>.json with every PayPal id.
//
//   npm run e2e:sandbox
//
// The steps are in scripts/lib/e2e-scenario.ts (shared with the replay test).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc } from "drizzle-orm";
import { openPglite } from "../src/db/client";
import { paypalCalls } from "../src/db/schema";
import { recordingFetch, type FetchLike } from "../src/paypal/recording";
import { Recordings } from "../src/receipts/recorded";
import { PledgeService } from "../src/server/service";
import { runScenario } from "./lib/e2e-scenario";

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "tests/fixtures/paypal/app-e2e");
const META = path.join(ROOT, "tests/fixtures/paypal/app-e2e.meta.json");
const EVIDENCE_DIR = path.join(ROOT, "evidence");
const VOLUNTEER = "sb-pywsi53523660@personal.example.com";
const CALL_BUDGET = 60;

async function main() {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox app.");

  rmSync(FIXTURES, { recursive: true, force: true });
  let step = "";
  let calls = 0;
  const counted: FetchLike = (url, init) => {
    if (!url.endsWith("/v1/oauth2/token") && ++calls > CALL_BUDGET) throw new Error(`call budget of ${CALL_BUDGET} exceeded`);
    return fetch(url, init);
  };
  const recorder = recordingFetch(counted, FIXTURES, { secrets: [clientId, clientSecret], label: () => step });

  const db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  const recordings = Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")));
  const steps: { step: string; at: string; note: string }[] = [];
  const driveId = `demo-${randomBytes(5).toString("hex")}`;

  const r = await runScenario({
    driveId,
    fetch: recorder,
    make: (f) =>
      new PledgeService({
        db: db.db,
        recordings,
        paypal: { clientId, clientSecret, fetch: f, retryDelayMs: 1000 },
        webhookId: null,
        demoPayoutEmail: VOLUNTEER,
        ipHashKey: `e2e-${runId}`,
        log: (m, x) => console.log(`  log: ${m}`, x ?? ""),
      }),
    read: (rel) => new Uint8Array(readFileSync(path.join(ROOT, rel))),
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
    onStep: (name, note) => {
      step = name;
      steps.push({ step: name, at: new Date().toISOString(), note });
      console.log(`- ${name}: ${note}`);
    },
  });

  const rows = await db.db.select().from(paypalCalls).orderBy(asc(paypalCalls.id));
  const ok = (x: (typeof rows)[number]) => x.httpStatus >= 200 && x.httpStatus < 300;
  const evidence = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox: "Nadezhda Korchagina's PayPal sandbox (Default Application APP-6EH18596R9530124Y), test card holds",
    driveId,
    paypalCalls: calls,
    steps,
    results: {
      walletPledge: r.wallet,
      authorizeBeforeApproval: r.authorizeBeforeApproval,
      heroReceipt: { id: r.hero.receipt.id, status: r.hero.receipt.status, commands: r.hero.commands },
      duplicateReceipt: { id: r.duplicate.id, status: r.duplicate.status, flags: r.duplicate.flags.map((f) => f.code) },
      preDisasterReceipt: { id: r.preDisaster.id, status: r.preDisaster.status, flags: r.preDisaster.flags.map((f) => f.code) },
      crash: r.crash,
      capturesBeforeCrash: r.capturesBeforeCrash,
      lookups: r.lookups,
      close: r.close,
    },
    ids: {
      holds: r.final.holds.map((h) => ({ pledgeId: h.pledgeId, orderId: h.orderId, authorizationId: h.authorizationId, status: h.status, captured: h.captured, released: h.released, currency: h.currency })),
      captures: rows.filter((x) => x.method === "POST" && x.path.endsWith("/capture") && ok(x)).map((x) => ({ requestId: x.requestId, captureId: x.ids.id, status: x.ids.status, httpStatus: x.httpStatus })),
      captureLookups: rows.filter((x) => x.method === "GET" && x.path.startsWith("/v2/payments/captures/")).map((x) => ({ captureId: x.ids.id, status: x.ids.status })),
      payouts: r.final.payouts,
      payoutLookups: rows.filter((x) => x.method === "GET" && x.path.startsWith("/v1/payments/payouts/")).map((x) => ({ ...x.ids })),
      voids: rows.filter((x) => x.path.endsWith("/void")).map((x) => ({ requestId: x.requestId, authorizationId: x.ids.id, status: x.ids.status, httpStatus: x.httpStatus })),
    },
    final: {
      driveStatus: r.final.drive.status,
      needs: r.final.needs,
      closeReport: r.final.closeReport,
      feeSavings: r.final.feeSavings,
      receipts: r.final.receipts.map((x) => ({ id: x.id, status: x.status, flags: x.flags.map((f) => f.code), image: x.image })),
      eventCount: r.final.eventCount,
    },
    calls: rows.map((x) => ({ ts: x.ts, method: x.method, path: x.path, requestId: x.requestId, httpStatus: x.httpStatus, debugId: x.debugId, ids: x.ids })),
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `e2e-${runId}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  writeFileSync(META, JSON.stringify({ runId, startedAt, driveId, volunteer: VOLUNTEER, evidence: path.relative(ROOT, file) }, null, 2) + "\n");
  await db.close();
  console.log(`\n${calls} PayPal calls. Drive ${driveId} is ${r.final.drive.status}. Evidence: ${path.relative(ROOT, file)}`);
  if (r.final.drive.status !== "closed") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
