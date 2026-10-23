import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  ResponseValidationError,
} from "@paypal/paypal-server-sdk";
import { isRetryableStatus, PayPalError } from "./errors";
import { toPayPalValue } from "./money";
import { parseAuthorization, parseCapture, parseOrder, parsePayoutBatch, parseWebhook } from "./parse";
import type { FetchLike } from "./recording";
import type { PayPalGateway } from "./types";
import type { Money } from "../core/types";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

/** Public sandbox test card from developer.paypal.com/tools/sandbox/card-testing (Visa). */
export const SANDBOX_TEST_CARD = { number: "4012888888881881", expiry: "2030-12", securityCode: "123", name: "Sandbox Donor" };

export interface GatewayOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Pause before retry n is n * retryDelayMs. */
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
}

/** Refused locally, never sent: not retried. */
export class GuardError extends Error {}

interface Raw {
  status: number;
  text: string;
  debugId?: string;
}

const TOKEN_PATH = "/v1/oauth2/token";
// POSTs that change nothing and need no idempotency key.
const NO_REQUEST_ID = new Set([TOKEN_PATH, "/v1/notifications/verify-webhook-signature"]);
const PREFER = "return=representation";

function requireId(requestId: string | undefined, op: string): string {
  if (!requestId || !requestId.trim()) throw new GuardError(`${op}: PayPal-Request-Id is required`);
  return requestId;
}

const sdkMoney = (m: Money) => ({ currencyCode: m.currency, value: toPayPalValue(m) });

export function createPayPalGateway(opts: GatewayOptions): PayPalGateway {
  const baseUrl = (opts.baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, "");
  if (baseUrl !== SANDBOX_BASE_URL) throw new GuardError(`Only the PayPal sandbox is supported, refusing ${baseUrl}`);
  if (!opts.clientId || !opts.clientSecret) throw new GuardError("PayPal client id and secret are required");
  const innerFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const now = opts.now ?? Date.now;

  // Every request, SDK or REST, passes here.
  const send: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== SANDBOX_BASE_URL) throw new GuardError(`Refusing non-sandbox URL ${u.origin}`);
    if (init.method.toUpperCase() === "POST" && !NO_REQUEST_ID.has(u.pathname)) {
      const id = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1];
      if (!id) throw new GuardError(`POST ${u.pathname} without PayPal-Request-Id`);
    }
    return innerFetch(url, init);
  };

  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  // Network errors, 5xx and 429 are retried with the identical request (same PayPal-Request-Id).
  async function withRetry(attempt: () => Promise<Raw>): Promise<Raw> {
    for (let i = 0; ; i++) {
      let raw: Raw;
      try {
        raw = await attempt();
      } catch (e) {
        if (e instanceof GuardError || e instanceof PayPalError) throw e;
        if (i >= maxRetries) throw new PayPalError({ httpStatus: 0, name: "NETWORK_ERROR", message: String((e as Error)?.message ?? e) });
        await sleep(retryDelayMs * (i + 1));
        continue;
      }
      if (isRetryableStatus(raw.status) && i < maxRetries) {
        await sleep(retryDelayMs * (i + 1));
        continue;
      }
      return raw;
    }
  }

  function ok(raw: Raw): unknown {
    if (raw.status >= 400 || raw.status < 200) throw PayPalError.fromResponse(raw.status, raw.text, raw.debugId);
    return raw.text ? JSON.parse(raw.text) : {};
  }

  async function fetchRaw(url: string, init: Parameters<FetchLike>[1]): Promise<Raw> {
    const res = await send(url, init);
    return { status: res.status, text: await res.text(), debugId: res.headers.get("paypal-debug-id") ?? undefined };
  }

  // OAuth client_credentials, cached until 60 s before expiry.
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<{ token: string; expiresAt: number }> | undefined;
  async function token(): Promise<{ token: string; expiresAt: number }> {
    if (cached && now() < cached.expiresAt) return cached;
    inflight ??= (async () => {
      const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
      const raw = await withRetry(() =>
        fetchRaw(baseUrl + TOKEN_PATH, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: "grant_type=client_credentials",
        }),
      );
      const body = ok(raw) as { access_token?: string; expires_in?: number };
      if (!body.access_token || typeof body.expires_in !== "number") throw new PayPalError({ httpStatus: raw.status, name: "BAD_TOKEN_RESPONSE" });
      cached = { token: body.access_token, expiresAt: now() + (body.expires_in - 60) * 1000 };
      return cached;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function rest(method: "GET" | "POST", path: string, o: { body?: unknown; rawBody?: string; requestId?: string } = {}): Promise<unknown> {
    const { token: t } = await token();
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json" };
    if (o.requestId) headers["PayPal-Request-Id"] = o.requestId;
    const body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return ok(await withRetry(() => fetchRaw(baseUrl + path, { method, headers, body })));
  }

  // The SDK talks axios; route it through `send` so guards, recording and replay see it too.
  const axiosAdapter = async (config: { url?: string; method?: string; headers?: { toJSON?: () => Record<string, unknown> }; data?: unknown }) => {
    const h = (config.headers?.toJSON ? config.headers.toJSON() : (config.headers as Record<string, unknown>)) ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (v !== undefined && v !== null && v !== false) headers[k] = String(v);
    const body = config.data === undefined || config.data === null ? undefined : typeof config.data === "string" ? config.data : JSON.stringify(config.data);
    const res = await send(String(config.url), { method: (config.method ?? "get").toUpperCase(), headers, body });
    const text = await res.text();
    return { data: text, status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), config, request: {} };
  };

  const client = new Client({
    environment: Environment.Sandbox,
    timeout: 30_000,
    clientCredentialsAuthCredentials: {
      oAuthClientId: opts.clientId,
      oAuthClientSecret: opts.clientSecret,
      oAuthTokenProvider: async () => {
        const t = await token();
        return { accessToken: t.token, tokenType: "Bearer", expiry: BigInt(Math.floor(t.expiresAt / 1000)) };
      },
    },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: { adapter: axiosAdapter },
  });
  const orders = new OrdersController(client);
  const payments = new PaymentsController(client);

  // We read PayPal's raw JSON rather than the SDK's mapped result: the SDK's strict enums
  // would turn an unexpected status value into a ResponseValidationError.
  async function sdk(call: () => Promise<{ statusCode: number; body: unknown; headers: Record<string, string> }>): Promise<unknown> {
    return ok(
      await withRetry(async () => {
        try {
          const r = await call();
          return { status: r.statusCode, text: typeof r.body === "string" ? r.body : "", debugId: r.headers["paypal-debug-id"] };
        } catch (e) {
          if (e instanceof ApiError || e instanceof ResponseValidationError) {
            return { status: e.statusCode, text: typeof e.body === "string" ? e.body : "", debugId: e.headers?.["paypal-debug-id"] };
          }
          throw e;
        }
      }),
    );
  }

  const purchaseUnit = (i: { pledgeId: string; driveId: string; amount: Money; description: string }) => ({
    referenceId: `${i.driveId}:${i.pledgeId}`,
    customId: i.pledgeId,
    description: i.description,
    amount: sdkMoney(i.amount),
  });

  return {
    async createAuthorizeOrder(i) {
      const requestId = requireId(i.requestId, "createAuthorizeOrder");
      const body = {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [purchaseUnit(i)],
        paymentSource: {
          paypal: {
            experienceContext: {
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              userAction: PaypalExperienceUserAction.Continue,
              returnUrl: i.returnUrl,
              cancelUrl: i.cancelUrl,
            },
          },
        },
      };
      return parseOrder(await sdk(() => orders.createOrder({ body, paypalRequestId: requestId, prefer: PREFER })));
    },

    async createAuthorizeOrderWithTestCard(i) {
      const requestId = requireId(i.requestId, "createAuthorizeOrderWithTestCard");
      const body = { intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [purchaseUnit(i)], paymentSource: { card: { ...SANDBOX_TEST_CARD } } };
      return parseOrder(await sdk(() => orders.createOrder({ body, paypalRequestId: requestId, prefer: PREFER })));
    },

    async authorizeOrder({ orderId, requestId }) {
      const id = requireId(requestId, "authorizeOrder");
      const order = parseOrder(await sdk(() => orders.authorizeOrder({ id: orderId, paypalRequestId: id, prefer: PREFER, body: {} })));
      if (!order.authorization) throw new Error(`Order ${orderId} authorized without an authorization in the response`);
      return order.authorization;
    },

    async getAuthorization(authorizationId) {
      return parseAuthorization(await sdk(() => payments.getAuthorizedPayment({ authorizationId })));
    },

    async captureAuthorization(i) {
      const requestId = requireId(i.requestId, "captureAuthorization");
      const body = { amount: sdkMoney(i.amount), finalCapture: i.finalCapture, invoiceId: i.invoiceId, noteToPayer: i.noteToPayer };
      return parseCapture(await sdk(() => payments.captureAuthorizedPayment({ authorizationId: i.authorizationId, paypalRequestId: requestId, prefer: PREFER, body })));
    },

    async reauthorize(i) {
      const requestId = requireId(i.requestId, "reauthorize");
      const body = i.amount ? { amount: sdkMoney(i.amount) } : {};
      // The response may carry a NEW authorization id; it is returned as is.
      return parseAuthorization(await sdk(() => payments.reauthorizePayment({ authorizationId: i.authorizationId, paypalRequestId: requestId, prefer: PREFER, body })));
    },

    async voidAuthorization(i) {
      const requestId = requireId(i.requestId, "voidAuthorization");
      await sdk(() => payments.voidPayment({ authorizationId: i.authorizationId, paypalRequestId: requestId, prefer: PREFER }));
    },

    async createPayout(i) {
      // sender_batch_id doubles as the idempotency key: PayPal also rejects a reused sender_batch_id.
      const requestId = requireId(i.senderBatchId, "createPayout");
      const body = {
        sender_batch_header: { sender_batch_id: i.senderBatchId, email_subject: i.emailSubject },
        items: i.items.map((it) => ({
          recipient_type: "EMAIL",
          receiver: it.receiverEmail,
          amount: { currency: it.amount.currency, value: toPayPalValue(it.amount) },
          sender_item_id: it.senderItemId,
          ...(it.note ? { note: it.note } : {}),
        })),
      };
      return parsePayoutBatch(await rest("POST", "/v1/payments/payouts", { body, requestId }));
    },

    async getPayoutBatch(payoutBatchId) {
      return parsePayoutBatch(await rest("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`));
    },

    async verifyWebhookSignature({ headers, rawBody, webhookId }) {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const fields = {
        auth_algo: h["paypal-auth-algo"],
        cert_url: h["paypal-cert-url"],
        transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"],
        transmission_time: h["paypal-transmission-time"],
        webhook_id: webhookId,
      };
      if (Object.values(fields).some((v) => !v)) return false; // not a PayPal delivery
      JSON.parse(rawBody); // must be JSON; throws otherwise
      // The event is spliced in byte for byte: re-serializing it can break the signature check.
      const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
      const res = (await rest("POST", "/v1/notifications/verify-webhook-signature", { rawBody: body })) as { verification_status?: string };
      return res.verification_status === "SUCCESS";
    },

    async listWebhooks() {
      const res = (await rest("GET", "/v1/notifications/webhooks")) as { webhooks?: unknown[] };
      return (res.webhooks ?? []).map(parseWebhook);
    },

    async createWebhook({ url, eventTypes, requestId }) {
      const id = requireId(requestId, "createWebhook");
      return parseWebhook(await rest("POST", "/v1/notifications/webhooks", { body: { url, event_types: eventTypes.map((name) => ({ name })) }, requestId: id }));
    },

    async simulateWebhookEvent({ webhookId, eventType, requestId }) {
      const id = requireId(requestId, "simulateWebhookEvent");
      const res = (await rest("POST", "/v1/notifications/simulate-event", { body: { webhook_id: webhookId, event_type: eventType }, requestId: id })) as {
        id?: string;
        event_type?: string;
      };
      if (!res.id) throw new Error("simulate-event response has no id");
      return { id: res.id, eventType: res.event_type ?? eventType };
    },
  };
}
