import { describe, expect, it, vi } from "vitest";
import { createPayPalGateway, GuardError } from "./gateway";
import { parseCapture } from "./parse";
import type { FetchLike } from "./recording";

// Hardening found by the acceptance panel (23.10): token refresh on 401, timeouts, request-id shape,
// lenient breakdown parsing after money moved, PAY_NOW by default, reauthorize replay without amount.

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(handler: (c: Call, n: number, signal?: AbortSignal) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetch: FetchLike = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: `t${++tokens}`, expires_in: 32400 });
    return handler(c, calls.filter((x) => !x.url.endsWith("/v1/oauth2/token")).length, init.signal);
  };
  const pp = createPayPalGateway({ clientId: "c", clientSecret: "s", fetch, retryDelayMs: 0, timeoutMs: 50 });
  const bearer = (c: Call) => Object.entries(c.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  return { pp, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length, bearer };
}

const auth = (id: string) => ({ id, status: "CREATED", amount: { currency_code: "EUR", value: "20.00" }, expiration_time: "2026-11-21T14:35:49Z" });

describe("401 drops the cached token and retries once", () => {
  it("REST path (payout batch)", async () => {
    const f = fake((c) =>
      f.bearer(c) === "Bearer t1" ? json(401, { error: "invalid_token" }) : json(200, { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" }, items: [] }),
    );
    await expect(f.pp.getPayoutBatch("B1")).resolves.toMatchObject({ payoutBatchId: "B1", batchStatus: "SUCCESS" });
    expect(f.tokenCalls()).toBe(2);
  });

  it("SDK path (authorization)", async () => {
    const f = fake((c) => (f.bearer(c) === "Bearer t1" ? json(401, { name: "AUTHENTICATION_FAILURE" }) : json(200, auth("A1"))));
    await expect(f.pp.getAuthorization("A1")).resolves.toMatchObject({ id: "A1", amount: { currency: "EUR", minor: 2000 } });
    expect(f.tokenCalls()).toBe(2);
  });

  it("a second 401 is reported, not looped", async () => {
    const f = fake(() => json(401, { name: "AUTHENTICATION_FAILURE" }));
    await expect(f.pp.getAuthorization("A1")).rejects.toMatchObject({ httpStatus: 401 });
    expect(f.tokenCalls()).toBe(2);
  });
});

describe("timeouts", () => {
  it("a capture that times out is retried with the same PayPal-Request-Id", async () => {
    const f = fake((c, n, signal) =>
      n === 1
        ? new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
        : json(201, { id: "C1", status: "COMPLETED", amount: { currency_code: "JPY", value: "1110" }, final_capture: false }),
    );
    const res = await f.pp.captureAuthorization({ authorizationId: "A1", amount: { currency: "JPY", minor: 1110 }, finalCapture: false, requestId: "cap:d:p:1" });
    expect(res).toMatchObject({ id: "C1", status: "COMPLETED" });
    const posts = f.calls.filter((c) => c.method === "POST" && c.url.includes("/capture"));
    expect(posts).toHaveLength(2);
    const ids = posts.map((c) => Object.entries(c.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1]);
    expect(ids).toEqual(["cap:d:p:1", "cap:d:p:1"]);
  });
});

describe("timeouts on the REST path", () => {
  it("a payout lookup that times out is retried", async () => {
    const f = fake((c, n, signal) =>
      n === 1
        ? new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
        : json(200, { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" }, items: [] }),
    );
    await expect(f.pp.getPayoutBatch("B1")).resolves.toMatchObject({ batchStatus: "SUCCESS" });
    expect(f.calls.filter((c) => c.url.includes("/v1/payments/payouts/B1"))).toHaveLength(2);
  });
});

describe("request id shape", () => {
  for (const bad of ["cap d p 1", "заказ-1", "x".repeat(109)]) {
    it(`refuses ${JSON.stringify(bad.slice(0, 12))} before sending`, async () => {
      const f = fake(() => json(201, {}));
      await expect(f.pp.voidAuthorization({ authorizationId: "A1", requestId: bad })).rejects.toBeInstanceOf(GuardError);
      expect(f.calls).toHaveLength(0);
    });
  }
});

describe("orders default to PAY_NOW", () => {
  it("sends user_action PAY_NOW unless CONTINUE is asked for", async () => {
    const f = fake(() => json(200, { id: "O1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=O1" }] }));
    const base = { pledgeId: "p", driveId: "d", amount: { currency: "EUR" as const, minor: 2000 }, description: "Water", requestId: "order:p" };
    await f.pp.createAuthorizeOrder(base);
    await f.pp.createAuthorizeOrder({ ...base, requestId: "order:p2", userAction: "CONTINUE" });
    const actions = f.calls.filter((c) => c.url.endsWith("/v2/checkout/orders")).map((c) => JSON.parse(c.body!).payment_source.paypal.experience_context.user_action);
    expect(actions).toEqual(["PAY_NOW", "CONTINUE"]);
  });
});

describe("reauthorize replay without amount", () => {
  it("reads the authorization by its (new) id", async () => {
    const f = fake((c) => (c.method === "POST" ? json(200, { id: "A2", status: "CREATED" }) : json(200, auth("A2"))));
    await expect(f.pp.reauthorize({ authorizationId: "A1", requestId: "reauth:p:1" })).resolves.toMatchObject({ id: "A2", amount: { currency: "EUR", minor: 2000 } });
    expect(f.calls.some((c) => c.method === "GET" && c.url.endsWith("/v2/payments/authorizations/A2"))).toBe(true);
  });
});

describe("webhook body that is not JSON", () => {
  it("is not verified and PayPal is not called", async () => {
    const f = fake(() => json(200, { verification_status: "SUCCESS" }));
    const headers = { "paypal-auth-algo": "a", "paypal-cert-url": "b", "paypal-transmission-id": "c", "paypal-transmission-sig": "d", "paypal-transmission-time": "e" };
    await expect(f.pp.verifyWebhookSignature({ headers, rawBody: "not json", webhookId: "W" })).resolves.toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("breakdown after a completed capture never throws", () => {
  it("drops an unreadable gross or rate and keeps the capture", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = { id: "C1", status: "COMPLETED", amount: { currency_code: "JPY", value: "1110" } };
    expect(parseCapture({ ...base, seller_receivable_breakdown: { gross_amount: { currency_code: "XAF", value: "1" } } }).sellerReceivable).toBeUndefined();
    const r = parseCapture({
      ...base,
      seller_receivable_breakdown: {
        gross_amount: { currency_code: "JPY", value: "1110" },
        paypal_fee: { currency_code: "JPY", value: "78" },
        exchange_rate: { source_currency: "JPY", target_currency: "XAF", value: "4.1" },
      },
    });
    expect(r.sellerReceivable).toEqual({ gross: { currency: "JPY", minor: 1110 }, paypalFee: { currency: "JPY", minor: 78 } });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
