/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped recorded PayPal JSON */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPayPalGateway, GuardError } from "./gateway";
import { PayPalError } from "./errors";
import { loadExchanges, replayFetch, type FetchLike, type RecordedExchange } from "./recording";
import type { Money } from "../core/types";

// Contract tests: every response below was recorded from Nadezhda's PayPal sandbox
// by scripts/sandbox-story.ts. Replay is strict: the gateway must send exactly the
// recorded request body, so these tests pin the request contract too.

const FIXTURES = path.resolve(__dirname, "../../tests/fixtures/paypal/story");
const ALL = loadExchanges(FIXTURES);
const fx = (label: string): RecordedExchange => {
  const hits = ALL.filter((e) => e.label === label);
  if (hits.length === 0) throw new Error(`no fixture ${label}`);
  return hits[0];
};
const fxAll = (label: string) => ALL.filter((e) => e.label === label);
const reqBody = (e: RecordedExchange) => e.request.body as Record<string, any>;
const reqId = (e: RecordedExchange) => e.request.headers["paypal-request-id"];
const authIdOf = (e: RecordedExchange) => /\/authorizations\/([^/]+)/.exec(e.request.url)![1];
const money = (o: { currency_code: string; value: string }): Money =>
  ({ currency: o.currency_code, minor: o.currency_code === "JPY" ? Number(o.value) : Math.round(Number(o.value) * 100) }) as Money;

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };

function gateway(exchanges: RecordedExchange[], opts: { maxRetries?: number; now?: () => number; wrap?: (f: FetchLike) => FetchLike } = {}) {
  const sent: Sent[] = [];
  const replay = replayFetch(exchanges);
  const base: FetchLike = (url, init) => {
    sent.push({ url, ...init });
    return replay(url, init);
  };
  const pp = createPayPalGateway({ clientId: "test-client", clientSecret: "test-secret", fetch: opts.wrap ? opts.wrap(base) : base, retryDelayMs: 0, ...opts });
  const posts = () => sent.filter((s) => s.method === "POST" && !s.url.endsWith("/v1/oauth2/token"));
  const header = (s: Sent, name: string) => Object.entries(s.headers).find(([k]) => k.toLowerCase() === name)?.[1];
  return { pp, sent, posts, header };
}

describe("holds (Orders v2, intent AUTHORIZE, test card)", () => {
  for (const key of ["eur", "jpy", "match"]) {
    it(`creates and authorizes the ${key} hold in one call`, async () => {
      const e = fx(`hold-${key}`);
      const unit = reqBody(e).purchase_units[0];
      const [driveId, pledgeId] = unit.reference_id.split(":");
      const { pp, posts, header } = gateway([e]);
      const order = await pp.createAuthorizeOrderWithTestCard({ pledgeId, driveId, amount: money(unit.amount), description: unit.description, requestId: reqId(e) });

      const auth = (e.response.body as any).purchase_units[0].payments.authorizations[0];
      expect(order).toMatchObject({ id: (e.response.body as any).id, status: "COMPLETED" });
      expect(order.authorization).toMatchObject({ id: auth.id, status: "CREATED", amount: money(auth.amount), expirationTime: auth.expiration_time });
      expect(unit.custom_id).toBe(pledgeId);
      expect(header(posts()[0], "paypal-request-id")).toBe(reqId(e));
      expect(header(posts()[0], "prefer")).toBe("return=representation");
    });
  }

  it("sends JPY without decimals", () => {
    expect(reqBody(fx("hold-match")).purchase_units[0].amount).toEqual({ currency_code: "JPY", value: "50000" });
    expect(reqBody(fx("hold-jpy")).purchase_units[0].amount).toEqual({ currency_code: "JPY", value: "3000" });
  });
});

describe("retries", () => {
  it("retries a 500 with the same PayPal-Request-Id and accepts the 201 that follows (real sandbox 500)", async () => {
    const [first, second] = fxAll("hold-usd");
    expect(first.response.status).toBe(500);
    expect(second.response.status).toBe(201);
    const unit = reqBody(second).purchase_units[0];
    const [driveId, pledgeId] = unit.reference_id.split(":");
    const { pp, posts, header } = gateway([first, second]);
    const order = await pp.createAuthorizeOrderWithTestCard({ pledgeId, driveId, amount: money(unit.amount), description: unit.description, requestId: reqId(second) });
    expect(order.authorization?.id).toBe((second.response.body as any).purchase_units[0].payments.authorizations[0].id);
    expect(posts()).toHaveLength(2);
    expect(posts().map((p) => header(p, "paypal-request-id"))).toEqual([reqId(second), reqId(second)]);
  });

  it("gives up after the retry budget and reports the 500 with the debug id from the header", async () => {
    const [first, second] = fxAll("hold-usd");
    const unit = reqBody(second).purchase_units[0];
    const [driveId, pledgeId] = unit.reference_id.split(":");
    const { pp, posts } = gateway([first], { maxRetries: 0 });
    const err = await pp
      .createAuthorizeOrderWithTestCard({ pledgeId, driveId, amount: money(unit.amount), description: unit.description, requestId: reqId(second) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ httpStatus: 500, name: "INTERNAL_SERVER_ERROR", debugId: first.response.headers["paypal-debug-id"] });
    expect(posts()).toHaveLength(1);
  });

  it("retries a network failure with the same request id", async () => {
    const e = fx("capture2-usd");
    const b = reqBody(e);
    const attempts: (string | undefined)[] = [];
    const { pp } = gateway([e], {
      wrap: (f) => (url, init) => {
        if (init.method === "POST" && url.endsWith("/capture")) {
          attempts.push(init.headers["PayPal-Request-Id"]);
          if (attempts.length === 1) return Promise.reject(new TypeError("fetch failed"));
        }
        return f(url, init);
      },
    });
    const cap = await pp.captureAuthorization({ authorizationId: authIdOf(e), amount: money(b.amount), finalCapture: false, requestId: reqId(e), invoiceId: b.invoice_id });
    expect(cap.id).toBe((e.response.body as any).id);
    expect(attempts).toEqual([reqId(e), reqId(e)]);
  });

  it("turns a persistent network failure into a PayPalError after 1 + 3 attempts", async () => {
    let attempts = 0;
    const { pp } = gateway([], {
      wrap: (f) => (url, init) => (url.endsWith("/v1/oauth2/token") ? f(url, init) : (attempts++, Promise.reject(new TypeError("fetch failed")))),
    });
    const err = await pp.getAuthorization("ANY").catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 0, name: "NETWORK_ERROR" });
    expect(attempts).toBe(4);
  });
});

describe("captures (partial, across holds)", () => {
  it("parses seller_receivable_breakdown with conversion to the merchant's USD balance (JPY)", async () => {
    const e = fx("capture1-jpy");
    const b = reqBody(e);
    const { pp, posts, header } = gateway([e]);
    const cap = await pp.captureAuthorization({
      authorizationId: authIdOf(e),
      amount: money(b.amount),
      finalCapture: false,
      requestId: reqId(e),
      invoiceId: b.invoice_id,
      noteToPayer: b.note_to_payer,
    });
    expect(b).toMatchObject({ amount: { currency_code: "JPY", value: "1110" }, final_capture: false });
    expect(cap).toMatchObject({ status: "COMPLETED", finalCapture: false, amount: { currency: "JPY", minor: 1110 } });
    expect(cap.sellerReceivable).toEqual({
      gross: { currency: "JPY", minor: 1110 },
      paypalFee: { currency: "JPY", minor: 78 },
      net: { currency: "USD", minor: 636 },
      receivable: { currency: "USD", minor: 636 },
      exchangeRate: { sourceCurrency: "JPY", targetCurrency: "USD", value: "0.006160397803739" },
    });
    expect(header(posts()[0], "prefer")).toBe("return=representation");
  });

  it("parses a same-currency capture where PayPal sends an empty exchange_rate", async () => {
    const e = fx("capture1-usd");
    const b = reqBody(e);
    const { pp } = gateway([e]);
    const cap = await pp.captureAuthorization({ authorizationId: authIdOf(e), amount: money(b.amount), finalCapture: false, requestId: reqId(e), invoiceId: b.invoice_id, noteToPayer: b.note_to_payer });
    expect(cap.sellerReceivable).toEqual({ gross: { currency: "USD", minor: 1110 }, paypalFee: { currency: "USD", minor: 78 }, net: { currency: "USD", minor: 1032 } });
  });

  it("treats PayPal's 200 replay of an already-processed request id as success with the same capture", async () => {
    const first = fx("capture1-eur");
    const again = fx("capture1-eur-repeat");
    expect([first.response.status, again.response.status]).toEqual([201, 200]);
    expect(reqId(again)).toBe(reqId(first));
    const b = reqBody(first);
    const { pp } = gateway([first, again]);
    const input = { authorizationId: authIdOf(first), amount: money(b.amount), finalCapture: false, requestId: reqId(first), invoiceId: b.invoice_id, noteToPayer: b.note_to_payer };
    const a1 = await pp.captureAuthorization(input);
    const a2 = await pp.captureAuthorization(input);
    expect(a2.id).toBe(a1.id);
    expect(a2.amount).toEqual({ currency: "EUR", minor: 740 });
  });

  it("marks the final capture", async () => {
    const e = fx("capture3-usd-final");
    const { pp } = gateway([e]);
    const cap = await pp.captureAuthorization({ authorizationId: authIdOf(e), amount: money(reqBody(e).amount), finalCapture: true, requestId: reqId(e) });
    expect(cap).toMatchObject({ finalCapture: true, amount: { currency: "USD", minor: 1290 } });
  });

  it("rejects fractional yen before anything is sent", async () => {
    const { pp, sent } = gateway([]);
    await expect(pp.captureAuthorization({ authorizationId: "A", amount: { currency: "JPY", minor: 1110.5 }, finalCapture: false, requestId: "r1" })).rejects.toThrow(/whole number/);
    expect(sent).toHaveLength(0);
  });
});

describe("PayPal errors (recorded 422s) are not retried", () => {
  const cases: [string, string][] = [
    ["reauthorize-day0", "REAUTHORIZATION_TOO_SOON"],
    ["capture-after-final", "AUTHORIZATION_ALREADY_CAPTURED"],
    ["wallet-authorize-unapproved", "ORDER_NOT_APPROVED"],
  ];
  for (const [label, issue] of cases) {
    it(issue, async () => {
      const e = fx(label);
      const { pp, posts } = gateway([e]);
      const call =
        label === "reauthorize-day0"
          ? pp.reauthorize({ authorizationId: authIdOf(e), requestId: reqId(e) })
          : label === "capture-after-final"
            ? pp.captureAuthorization({ authorizationId: authIdOf(e), amount: money(reqBody(e).amount), finalCapture: false, requestId: reqId(e) })
            : pp.authorizeOrder({ orderId: /orders\/([^/]+)\/authorize/.exec(e.request.url)![1], requestId: reqId(e) });
      const err = await call.catch((x) => x);
      expect(err).toBeInstanceOf(PayPalError);
      expect(err).toMatchObject({ httpStatus: 422, name: "UNPROCESSABLE_ENTITY", issue, debugId: (e.response.body as any).debug_id });
      expect(posts()).toHaveLength(1);
    });
  }
});

describe("authorizations", () => {
  it("reads PARTIALLY_CAPTURED and VOIDED holds", async () => {
    const partial = fx("capture2-get-match");
    const voided = fx("void-get-match");
    const { pp } = gateway([partial, voided]);
    expect(await pp.getAuthorization(authIdOf(partial))).toMatchObject({ status: "PARTIALLY_CAPTURED", amount: { currency: "JPY", minor: 50000 } });
    expect(await pp.getAuthorization(authIdOf(voided))).toMatchObject({ status: "VOIDED" });
  });

  it("voids with a request id", async () => {
    const e = fx("void-eur");
    const { pp, posts, header } = gateway([e]);
    await expect(pp.voidAuthorization({ authorizationId: authIdOf(e), requestId: reqId(e) })).resolves.toBeUndefined();
    expect(header(posts()[0], "paypal-request-id")).toBe(reqId(e));
  });
});

describe("wallet approval path", () => {
  it("creates an order without shipping and returns the payer-action link", async () => {
    const e = fx("wallet-order");
    const b = reqBody(e);
    const unit = b.purchase_units[0];
    const [driveId, pledgeId] = unit.reference_id.split(":");
    const ctx = b.payment_source.paypal.experience_context;
    expect(ctx.shipping_preference).toBe("NO_SHIPPING");
    const { pp } = gateway([e]);
    const order = await pp.createAuthorizeOrder({ pledgeId, driveId, amount: money(unit.amount), description: unit.description, requestId: reqId(e), returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url });
    expect(order).toEqual({ id: (e.response.body as any).id, status: "PAYER_ACTION_REQUIRED", approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${(e.response.body as any).id}`, authorization: undefined });
  });
});

describe("payouts (REST)", () => {
  it("creates a JPY batch keyed by sender_batch_id and reads it to SUCCESS with fees and conversion", async () => {
    const create = fx("payout-create");
    const done = ALL.filter((e) => e.label?.startsWith("payout-get")).at(-1)!;
    const b = reqBody(create);
    const item = b.items[0];
    const { pp, posts, header } = gateway([create, done]);
    const batch = await pp.createPayout({
      senderBatchId: b.sender_batch_header.sender_batch_id,
      emailSubject: b.sender_batch_header.email_subject,
      items: [{ senderItemId: item.sender_item_id, receiverEmail: item.receiver, amount: { currency: "JPY", minor: Number(item.amount.value) }, note: item.note }],
    });
    expect(item.amount).toEqual({ currency: "JPY", value: "2220" });
    expect(header(posts()[0], "paypal-request-id")).toBe(b.sender_batch_header.sender_batch_id);
    expect(batch).toMatchObject({ batchStatus: "PENDING", items: [] });

    const got = await pp.getPayoutBatch(batch.payoutBatchId);
    expect(got).toMatchObject({
      payoutBatchId: batch.payoutBatchId,
      batchStatus: "SUCCESS",
      amount: { currency: "JPY", minor: 2220 },
      fees: { currency: "JPY", minor: 44 },
      currencyConversion: { from: { currency: "USD", minor: 1482 }, to: { currency: "JPY", minor: 2264 } },
    });
    expect(got.items[0]).toMatchObject({ senderItemId: item.sender_item_id, transactionStatus: "SUCCESS" });
    expect(got.items[0].transactionId).toBeTruthy();
  });

  it("refuses a payout without a sender_batch_id", async () => {
    const { pp, sent } = gateway([]);
    await expect(pp.createPayout({ senderBatchId: "", emailSubject: "x", items: [] })).rejects.toBeInstanceOf(GuardError);
    expect(sent).toHaveLength(0);
  });
});

describe("webhooks (REST)", () => {
  it("lists, creates and simulates", async () => {
    const list = fx("webhooks-list");
    const create = fx("webhook-create");
    const sim = fx("webhook-simulate");
    const { pp } = gateway([list, create, sim]);
    expect(await pp.listWebhooks()).toEqual(((list.response.body as any).webhooks ?? []).map((w: any) => expect.objectContaining({ id: w.id })));
    const cb = reqBody(create);
    const hook = await pp.createWebhook({ url: cb.url, eventTypes: cb.event_types.map((t: any) => t.name), requestId: reqId(create) });
    expect(hook).toMatchObject({ id: (create.response.body as any).id, url: cb.url, eventTypes: cb.event_types.map((t: any) => t.name) });
    const ev = await pp.simulateWebhookEvent({ webhookId: hook.id, eventType: reqBody(sim).event_type, requestId: reqId(sim) });
    expect(ev).toEqual({ id: (sim.response.body as any).id, eventType: "PAYMENT.CAPTURE.COMPLETED" });
  });

  it("reports a forged signature as not verified", async () => {
    const e = fx("webhook-verify-forged");
    const b = reqBody(e);
    const { pp } = gateway([e]);
    const ok = await pp.verifyWebhookSignature({
      webhookId: b.webhook_id,
      rawBody: JSON.stringify(b.webhook_event),
      headers: {
        "PayPal-Auth-Algo": b.auth_algo,
        "PayPal-Cert-Url": b.cert_url,
        "PayPal-Transmission-Id": b.transmission_id,
        "PayPal-Transmission-Sig": b.transmission_sig,
        "PayPal-Transmission-Time": b.transmission_time,
      },
    });
    expect(ok).toBe(false);
  });

  it("does not call PayPal when the delivery lacks PayPal's signature headers", async () => {
    const { pp, sent } = gateway([]);
    expect(await pp.verifyWebhookSignature({ webhookId: "W", rawBody: "{}", headers: {} })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("guards", () => {
  it("refuses any base URL other than the sandbox", () => {
    for (const baseUrl of ["https://api-m.paypal.com", "https://api.paypal.com", "http://api-m.sandbox.paypal.com", "https://api-m.sandbox.paypal.com.evil.test"]) {
      expect(() => createPayPalGateway({ clientId: "c", clientSecret: "s", baseUrl })).toThrow(GuardError);
    }
    expect(() => createPayPalGateway({ clientId: "c", clientSecret: "s", baseUrl: "https://api-m.sandbox.paypal.com/" })).not.toThrow();
  });

  it("refuses a state-changing call without a PayPal-Request-Id before sending", async () => {
    const { pp, sent } = gateway([]);
    await expect(pp.captureAuthorization({ authorizationId: "A", amount: { currency: "USD", minor: 100 }, finalCapture: false, requestId: "" })).rejects.toBeInstanceOf(GuardError);
    await expect(pp.voidAuthorization({ authorizationId: "A", requestId: "  " })).rejects.toBeInstanceOf(GuardError);
    await expect(pp.reauthorize({ authorizationId: "A", requestId: undefined as never })).rejects.toBeInstanceOf(GuardError);
    expect(sent).toHaveLength(0);
  });

  it("every POST recorded live carried a request id; orders and payments POSTs also asked for the full representation", () => {
    const posts = ALL.filter((e) => e.request.method === "POST" && !e.request.url.endsWith("/verify-webhook-signature"));
    expect(posts.length).toBeGreaterThan(20);
    for (const e of posts) {
      expect(reqId(e), e.label).toMatch(/^pas-/);
      if (/\/v2\//.test(e.request.url)) expect(e.request.headers.prefer, e.label).toBe("return=representation");
    }
  });

  it("recordings contain no credentials", () => {
    for (const f of readdirSync(FIXTURES)) {
      const raw = readFileSync(path.join(FIXTURES, f), "utf8");
      for (const needle of ["Bearer ", "Basic ", "access_token", "client_secret"]) expect(raw, f).not.toContain(needle);
    }
  });
});

describe("OAuth token cache", () => {
  // REST calls ask the cache every time; the SDK keeps the token it was handed until the same expiry.
  it("reuses the token until 60 s before expiry, then fetches a new one", async () => {
    const a = fx("payout-get-1");
    const b = fx("payout-get-2");
    const c = fx("webhooks-list");
    let t = 1_000_000;
    const { pp, sent } = gateway([a, b, c], { now: () => t });
    const tokenCalls = () => sent.filter((s) => s.url.endsWith("/v1/oauth2/token")).length;
    const batchId = (e: RecordedExchange) => e.request.url.split("/").pop()!;
    await pp.getPayoutBatch(batchId(a));
    t += (32400 - 61) * 1000;
    await pp.getPayoutBatch(batchId(b));
    expect(tokenCalls()).toBe(1);
    t += 2000;
    await pp.listWebhooks();
    expect(tokenCalls()).toBe(2);
  });
});
