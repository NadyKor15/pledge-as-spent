// Live "Japanese story" in Nadezhda's PayPal sandbox: multi-currency holds,
// partial captures across holds, a JPY payout, reauthorize, void. Records every
// exchange (sanitized) as contract-test fixtures and writes an evidence file.
//
//   npm run story:sandbox
//   PAYPAL_SANDBOX_VOLUNTEER_EMAIL=...  (payout step is skipped when unset)

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPayPalGateway } from "../src/paypal/gateway";
import { PayPalError } from "../src/paypal/errors";
import { loadExchanges, recordingFetch, type FetchLike, type RecordedExchange } from "../src/paypal/recording";
import type { Money } from "../src/core/types";
import { readVaultSecrets } from "./lib/vault";

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "tests/fixtures/paypal/story");
const EVIDENCE_DIR = path.join(ROOT, "evidence");
const WEBHOOK_URL = "https://example.com/pledge-as-spent/paypal-webhook"; // placeholder until the app is deployed
const WEBHOOK_EVENTS = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
];

const m = (currency: Money["currency"], minor: number): Money => ({ currency, minor });

async function main() {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const secrets = await readVaultSecrets({
    project: "retailbox-general",
    environment: "prod",
    path: "/retailbox-internal-development",
    keys: ["PAYPAL_SANDBOX_NADYA_CLIENT_ID", "PAYPAL_SANDBOX_NADYA_SECRET"],
  });
  const clientId = secrets.PAYPAL_SANDBOX_NADYA_CLIENT_ID;
  const clientSecret = secrets.PAYPAL_SANDBOX_NADYA_SECRET;
  const volunteer = process.env.PAYPAL_SANDBOX_VOLUNTEER_EMAIL;

  rmSync(FIXTURES, { recursive: true, force: true });
  let step = "";
  let calls = 0;
  const counted: FetchLike = (url, init) => {
    calls += 1;
    if (calls > 55) throw new Error("call budget exceeded");
    return fetch(url, init);
  };
  const recorder = recordingFetch(counted, FIXTURES, { secrets: [clientId, clientSecret], label: () => step });
  // Sandbox negative testing: one request gets a mocked 500 to prove the retry keeps its PayPal-Request-Id.
  let mockOnce: string | undefined;
  const injector: FetchLike = (url, init) => {
    if (mockOnce && init.method === "POST") {
      const headers = { ...init.headers, "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: mockOnce }) };
      mockOnce = undefined;
      return recorder(url, { ...init, headers });
    }
    return recorder(url, init);
  };
  const pp = createPayPalGateway({ clientId, clientSecret, fetch: injector, retryDelayMs: 1000 });
  const rid = (s: string) => `pas-${runId}-${s}`;
  const notes: string[] = [];

  async function expectError(label: string, fn: () => Promise<unknown>) {
    step = label;
    try {
      await fn();
      notes.push(`${label}: expected an error, call succeeded`);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      notes.push(`${label}: ${e.httpStatus} ${e.name}/${e.issue ?? "-"} debug_id=${e.debugId ?? "-"}`);
    }
  }

  const drive = "drive-tohoku-2026";
  const holds = [
    { key: "eur", pledgeId: "pledge-de-anna", amount: m("EUR", 2000), desc: "Pledge EUR 20.00 — water" },
    { key: "usd", pledgeId: "pledge-us-mark", amount: m("USD", 3000), desc: "Pledge USD 30.00 — blankets" },
    { key: "jpy", pledgeId: "pledge-jp-yuki", amount: m("JPY", 3000), desc: "Pledge JPY 3000 — rice" },
    { key: "match", pledgeId: "pledge-match-company", amount: m("JPY", 50000), desc: "Company match JPY 50000" },
  ] as const;
  const auth: Record<string, string> = {};

  async function getAll(label: string, keys: string[]) {
    for (const k of keys) {
      step = `${label}-get-${k}`;
      await pp.getAuthorization(auth[k]);
    }
  }

  // 1. Holds (test card: create + authorize in one call). USD gets a mocked 500 first.
  for (const h of holds) {
    step = `hold-${h.key}`;
    if (h.key === "usd") mockOnce = "INTERNAL_SERVER_ERROR";
    const create = (requestId: string) =>
      pp.createAuthorizeOrderWithTestCard({ pledgeId: h.pledgeId, driveId: drive, amount: h.amount, description: h.desc, requestId });
    let order;
    try {
      order = await create(rid(`hold-${h.key}`));
    } catch (e) {
      // If PayPal replays the mocked 500 for the same id, record that and continue with a fresh id.
      if (!(h.key === "usd" && e instanceof PayPalError && e.httpStatus >= 500)) throw e;
      notes.push(`hold-usd: mocked 500 persisted across retries with the same id (${e.debugId ?? "-"})`);
      step = "hold-usd-fresh-id";
      order = await create(rid("hold-usd-2"));
    }
    if (!order.authorization) throw new Error(`hold ${h.key}: no authorization`);
    auth[h.key] = order.authorization.id;
  }
  await getAll("holds", Object.keys(auth));

  // 2. Wallet path: order awaiting the donor's approval; authorizing it before approval must fail.
  step = "wallet-order";
  const walletOrder = await pp.createAuthorizeOrder({
    pledgeId: "pledge-fr-claire",
    driveId: drive,
    amount: m("EUR", 1000),
    description: "Pledge EUR 10.00 — wallet approval path",
    requestId: rid("wallet-order"),
    returnUrl: "https://example.com/pledge-as-spent/return",
    cancelUrl: "https://example.com/pledge-as-spent/cancel",
  });
  if (!walletOrder.approveUrl) notes.push("wallet-order: no approve link");
  await expectError("wallet-authorize-unapproved", () => pp.authorizeOrder({ orderId: walletOrder.id, requestId: rid("wallet-authorize") }));

  // 3. Receipt lines split across holds: two partial captures per hold.
  const round1 = { eur: m("EUR", 740), usd: m("USD", 1110), jpy: m("JPY", 1110), match: m("JPY", 12000) };
  const round2 = { eur: m("EUR", 500), usd: m("USD", 600), jpy: m("JPY", 500), match: m("JPY", 8000) };
  for (const [k, amount] of Object.entries(round1)) {
    step = `capture1-${k}`;
    await pp.captureAuthorization({ authorizationId: auth[k], amount, finalCapture: false, requestId: rid(`cap1-${k}`), invoiceId: `${runId}-r1-${k}`, noteToPayer: "Receipt line 1 approved" });
  }
  await getAll("capture1", Object.keys(round1));

  // Same PayPal-Request-Id again: must return the same capture, not a second one.
  step = "capture1-eur-repeat";
  await pp.captureAuthorization({ authorizationId: auth.eur, amount: round1.eur, finalCapture: false, requestId: rid("cap1-eur"), invoiceId: `${runId}-r1-eur`, noteToPayer: "Receipt line 1 approved" });

  for (const [k, amount] of Object.entries(round2)) {
    step = `capture2-${k}`;
    await pp.captureAuthorization({ authorizationId: auth[k], amount, finalCapture: false, requestId: rid(`cap2-${k}`), invoiceId: `${runId}-r2-${k}` });
  }
  await getAll("capture2", Object.keys(round2));

  // 4. Reauthorize on day 0 (expected: too soon).
  await expectError("reauthorize-day0", () => pp.reauthorize({ authorizationId: auth.match, requestId: rid("reauth-match") }));

  // 5. Final capture of the USD remainder, then one more capture on the closed hold.
  step = "capture3-usd-final";
  await pp.captureAuthorization({ authorizationId: auth.usd, amount: m("USD", 1290), finalCapture: true, requestId: rid("cap3-usd") });
  await expectError("capture-after-final", () => pp.captureAuthorization({ authorizationId: auth.usd, amount: m("USD", 100), finalCapture: false, requestId: rid("cap4-usd") }));
  await getAll("final", ["usd"]);

  // 6. Volunteer reimbursement in JPY.
  if (volunteer) {
    step = "payout-create";
    const batch = await pp.createPayout({
      senderBatchId: rid("payout"),
      emailSubject: "Reimbursement for approved receipt",
      items: [{ senderItemId: `${runId}-vol-1`, receiverEmail: volunteer, amount: m("JPY", 2220), note: "Receipt 1 — water and rice" }],
    });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 12_000));
      step = `payout-get-${i + 1}`;
      const b = await pp.getPayoutBatch(batch.payoutBatchId);
      if (["SUCCESS", "DENIED", "CANCELED"].includes(b.batchStatus)) break;
    }
  } else {
    notes.push("payout: skipped, PAYPAL_SANDBOX_VOLUNTEER_EMAIL not set");
  }

  // 7. Drive closes: void what is left on the open holds.
  for (const k of ["eur", "jpy", "match"]) {
    step = `void-${k}`;
    await pp.voidAuthorization({ authorizationId: auth[k], requestId: rid(`void-${k}`) });
  }
  await getAll("void", ["eur", "jpy", "match"]);

  // 8. Webhooks: reuse or create the placeholder webhook, simulate an event, check a forged signature.
  step = "webhooks-list";
  let hook = (await pp.listWebhooks()).find((w) => w.url === WEBHOOK_URL);
  if (!hook) {
    step = "webhook-create";
    hook = await pp.createWebhook({ url: WEBHOOK_URL, eventTypes: WEBHOOK_EVENTS, requestId: rid("webhook") });
  }
  step = "webhook-simulate";
  await pp.simulateWebhookEvent({ webhookId: hook.id, eventType: "PAYMENT.CAPTURE.COMPLETED", requestId: rid("simulate") });
  step = "webhook-verify-forged";
  const verified = await pp.verifyWebhookSignature({
    webhookId: hook.id,
    rawBody: JSON.stringify({ id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X" } }),
    headers: {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
      "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
      "paypal-transmission-sig": "Zm9yZ2Vk",
      "paypal-transmission-time": new Date().toISOString(),
    },
  });
  notes.push(`webhook-verify-forged: verified=${verified}`);

  // Evidence from what was actually exchanged.
  const exchanges = loadExchanges(FIXTURES);
  const evidence = {
    run: runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sandbox: { app: "APP-6EH18596R9530124Y (Default Application, Nadezhda's sandbox)", baseUrl: "https://api-m.sandbox.paypal.com" },
    httpCalls: calls,
    oauthCalls: calls - exchanges.length,
    fixtures: path.relative(ROOT, FIXTURES),
    notes,
    calls: exchanges.map(summarize),
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceFile = path.join(EVIDENCE_DIR, `sandbox-story-${runId}.json`);
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");

  // Leak check over everything written: must be zero.
  const needles = ["Bearer ", "Basic ", "access_token", clientId, clientSecret];
  const files = [evidenceFile, ...readdirSync(FIXTURES).map((f) => path.join(FIXTURES, f))];
  const hits = files.reduce((n, f) => n + needles.filter((x) => readFileSync(f, "utf8").includes(x)).length, 0);
  console.log(`calls=${calls} recorded=${exchanges.length} evidence=${path.relative(ROOT, evidenceFile)} leak-hits=${hits}`);
  for (const n of notes) console.log(`note: ${n}`);
  if (hits > 0) process.exitCode = 2;
}

function summarize(e: RecordedExchange) {
  const b = (e.response.body ?? {}) as Record<string, any>;
  const p = new URL(e.request.url).pathname;
  const fromPath = /\/authorizations\/([^/]+)/.exec(p)?.[1];
  const ids: Record<string, string | undefined> = {};
  let status: string | undefined = b.status;
  let amount = b.amount;
  if (p === "/v2/checkout/orders" || /\/v2\/checkout\/orders\/[^/]+\/authorize$/.test(p)) {
    ids.order = b.id;
    const a = b.purchase_units?.[0]?.payments?.authorizations?.[0];
    ids.authorization = a?.id;
    amount = b.purchase_units?.[0]?.amount ?? a?.amount;
    if (a) status = `${b.status}/${a.status}`;
  } else if (p.endsWith("/capture")) {
    ids.authorization = fromPath;
    ids.capture = b.id;
  } else if (p.endsWith("/reauthorize")) {
    ids.authorizationBefore = fromPath;
    ids.authorization = b.id;
  } else if (fromPath) {
    ids.authorization = fromPath;
  } else if (p.startsWith("/v1/payments/payouts")) {
    ids.payoutBatch = b.batch_header?.payout_batch_id;
    ids.payoutItem = b.items?.[0]?.payout_item_id;
    ids.transaction = b.items?.[0]?.transaction_id;
    status = b.batch_header?.batch_status;
    amount = b.batch_header?.amount;
  } else if (p.startsWith("/v1/notifications")) {
    ids.webhookOrEvent = b.id;
    status = b.verification_status ?? b.event_type;
  }
  return {
    seq: e.seq,
    step: e.label,
    method: e.request.method,
    path: p,
    http: e.response.status,
    requestId: e.request.headers["paypal-request-id"],
    mockResponse: e.request.headers["paypal-mock-response"],
    ids: Object.fromEntries(Object.entries(ids).filter(([, v]) => v)),
    status,
    amount,
    finalCapture: b.final_capture,
    sellerReceivableBreakdown: b.seller_receivable_breakdown,
    payoutFees: b.batch_header?.fees,
    currencyConversion: b.batch_header?.currency_conversion,
    error: e.response.status >= 400 ? { name: b.name, issue: b.details?.[0]?.issue, message: b.message, debugId: b.debug_id ?? e.response.headers["paypal-debug-id"] } : undefined,
    debugId: e.response.headers["paypal-debug-id"],
  };
}

main().catch((e) => {
  if (e instanceof PayPalError) console.error(`FAILED: ${e.httpStatus} ${e.name}/${e.issue ?? "-"} ${e.message} debug_id=${e.debugId ?? "-"}`);
  else console.error(`FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
});
