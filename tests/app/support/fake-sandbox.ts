/* eslint-disable @typescript-eslint/no-explicit-any -- builds PayPal-shaped JSON */
import type { FetchLike } from "../../../src/paypal/recording";

// A stateful stand-in for the PayPal sandbox, for scenarios the recorded run
// does not cover (more receipts, more payouts, failures). Response shapes follow
// the recorded fixtures in tests/fixtures/paypal/story. Idempotency follows
// finding #8: a POST with a PayPal-Request-Id seen before returns the first
// response again with HTTP 200 and does nothing.

const ZERO_DECIMAL = new Set(["JPY"]);
const toMinor = (a: { currency_code?: string; currency?: string; value: string }) => {
  const cur = a.currency_code ?? a.currency!;
  return ZERO_DECIMAL.has(cur) ? Number(a.value) : Math.round(Number(a.value) * 100);
};
const fmt = (cur: string, minor: number) => (ZERO_DECIMAL.has(cur) ? String(minor) : (minor / 100).toFixed(2));
const FIXED: Record<string, number> = { EUR: 39, USD: 49, JPY: 49 };

interface Auth {
  id: string;
  orderId: string;
  currency: string;
  amount: number;
  captured: number;
  status: string;
  customId: string;
  /** Set on a reauthorization: the authorization it came from. */
  parentId?: string;
  /** PayPal's create_time and expiration_time, fixed when the authorization is made. */
  createdAt?: string;
  /** 29 days from the first approval; a reauthorization keeps its parent's (sandbox 24.10). */
  expiresAt?: string;
}

export interface FakeSandbox {
  fetch: FetchLike;
  /** Captures actually made, per authorization id. */
  captures: { id: string; authorizationId: string; minor: number; currency: string; requestId: string; invoiceId: string }[];
  payouts: { batchId: string; senderBatchId: string; minor: number; currency: string; receiver: string }[];
  voids: string[];
  /** Number of non-token requests that reached the fake. */
  calls: { method: string; path: string; requestId?: string; replayed: boolean }[];
  approve(orderId: string): void;
  /** Make the next POST to a path containing `pathPart` answer with this status and body. */
  failNext(pathPart: string, status: number, body: unknown): void;
  /** Payouts stay PENDING until this many GETs. */
  payoutGetsUntilSuccess: number;
  /** Capture status reported for new captures. */
  captureStatus: string;
  /** "new_id": reauthorize returns a new authorization id; "too_soon": 422 REAUTHORIZATION_TOO_SOON. */
  reauthorize: "new_id" | "too_soon";
  reauthorizations: { from: string; to: string; minor: number }[];
}

/** Fixed start of every test run, shared with the harness clock: nothing here may read the wall clock. */
export const FAKE_EPOCH = "2026-10-23T16:00:00Z";

export function fakeSandbox(opts: { now?: () => string } = {}): FakeSandbox {
  const now = opts.now ?? (() => FAKE_EPOCH);
  let n = 0;
  const id = (p: string) => `${p}${String(++n).padStart(6, "0")}FAKE`;
  const orders = new Map<string, any>();
  const approved = new Set<string>();
  const auths = new Map<string, Auth>();
  const captureById = new Map<string, any>();
  const payoutById = new Map<string, { body: any; gets: number }>();
  const seen = new Map<string, { status: number; body: string }>();
  const failures: { pathPart: string; status: number; body: unknown }[] = [];

  const state: FakeSandbox = {
    fetch: null as unknown as FetchLike,
    captures: [],
    payouts: [],
    voids: [],
    calls: [],
    approve: (orderId) => approved.add(orderId),
    failNext: (pathPart, status, body) => failures.push({ pathPart, status, body }),
    payoutGetsUntilSuccess: 1,
    captureStatus: "COMPLETED",
    reauthorize: "new_id",
    reauthorizations: [],
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": `fake${n}` } });
  const error = (status: number, name: string, issue: string) => json(status, { name, details: [{ issue, description: issue }], debug_id: `fake${n}` });

  const authJson = (a: Auth) => ({
    id: a.id,
    status: a.status,
    amount: { currency_code: a.currency, value: fmt(a.currency, a.amount) },
    custom_id: a.customId,
    create_time: a.createdAt ?? now(),
    expiration_time: a.expiresAt ?? new Date(Date.parse(a.createdAt ?? now()) + 29 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
  });

  function handle(method: string, path: string, body: any): Response {
    if (method === "POST" && path === "/v2/checkout/orders") {
      const unit = body.purchase_units[0];
      const orderId = id("ORD");
      const order: any = { id: orderId, intent: "AUTHORIZE", purchase_units: [{ reference_id: unit.reference_id, custom_id: unit.custom_id, amount: unit.amount }] };
      orders.set(orderId, order);
      if (body.payment_source?.card) {
        const a: Auth = { id: id("AUTH"), orderId, currency: unit.amount.currency_code, amount: toMinor(unit.amount), captured: 0, status: "CREATED", customId: unit.custom_id, createdAt: now() };
        auths.set(a.id, a);
        order.status = "COMPLETED";
        order.purchase_units[0].payments = { authorizations: [authJson(a)] };
        return json(201, order);
      }
      order.status = "PAYER_ACTION_REQUIRED";
      order.links = [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, method: "GET" }];
      return json(200, order);
    }
    let m = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path);
    if (method === "POST" && m) {
      const order = orders.get(m[1]);
      if (!order) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (!approved.has(m[1])) return error(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED");
      const unit = order.purchase_units[0];
      const a: Auth = { id: id("AUTH"), orderId: m[1], currency: unit.amount.currency_code, amount: toMinor(unit.amount), captured: 0, status: "CREATED", customId: unit.custom_id, createdAt: now() };
      auths.set(a.id, a);
      order.status = "COMPLETED";
      unit.payments = { authorizations: [authJson(a)] };
      return json(201, order);
    }
    m = /^\/v2\/payments\/authorizations\/([^/]+)(\/capture|\/void|\/reauthorize)?$/.exec(path);
    if (m) {
      const a = auths.get(m[1]);
      if (!a) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (method === "GET" && !m[2]) return json(200, authJson(a));
      if (m[2] === "/void") {
        // As in the sandbox (evidence/reauth-probe-20261031T223634Z.json): a reauthorization cannot be
        // voided, and a void of the parent ends every reauthorization of it.
        if (a.parentId) return error(422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_VOIDED");
        if (a.status === "VOIDED") return error(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED");
        a.status = "VOIDED";
        for (const child of auths.values()) if (child.parentId === a.id) child.status = "VOIDED";
        state.voids.push(a.id);
        return json(200, authJson(a));
      }
      if (m[2] === "/reauthorize") {
        if (state.reauthorize === "too_soon") return error(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_TOO_SOON");
        if (a.parentId) return error(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_NOT_SUPPORTED");
        const minor = body.amount ? toMinor(body.amount) : a.amount - a.captured;
        const b: Auth = { ...a, id: id("AUTH"), parentId: a.id, amount: minor, captured: 0, status: "CREATED", createdAt: now(), expiresAt: authJson(a).expiration_time };
        auths.set(b.id, b);
        state.reauthorizations.push({ from: a.id, to: b.id, minor });
        return json(201, authJson(b));
      }
      if (m[2] === "/capture") {
        if (a.status === "VOIDED") return error(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED");
        const minor = toMinor(body.amount);
        if (a.captured + minor > a.amount) return error(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED");
        a.captured += minor;
        a.status = "PARTIALLY_CAPTURED";
        const parent = a.parentId ? auths.get(a.parentId) : undefined;
        if (parent) {
          parent.captured += minor;
          parent.status = "PARTIALLY_CAPTURED";
        }
        const fee = Math.round((minor * 259) / 10_000) + (FIXED[a.currency] ?? 0);
        const c = {
          id: id("CAP"),
          amount: body.amount,
          final_capture: false,
          seller_receivable_breakdown: {
            gross_amount: body.amount,
            paypal_fee: { currency_code: a.currency, value: fmt(a.currency, fee) },
            net_amount: { currency_code: a.currency, value: fmt(a.currency, minor - fee) },
          },
          invoice_id: body.invoice_id,
          custom_id: a.customId,
          status: state.captureStatus,
          create_time: now(),
          update_time: now(),
        };
        captureById.set(c.id, c);
        state.captures.push({ id: c.id, authorizationId: a.id, minor, currency: a.currency, requestId: "", invoiceId: body.invoice_id });
        return json(201, c);
      }
    }
    m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const c = captureById.get(m[1]);
      return c ? json(200, c) : error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    if (method === "POST" && path === "/v1/payments/payouts") {
      const item = body.items[0];
      const batchId = id("PB");
      const header = { payout_batch_id: batchId, batch_status: "PENDING", sender_batch_header: body.sender_batch_header };
      payoutById.set(batchId, { body: { ...body, header }, gets: 0 });
      state.payouts.push({ batchId, senderBatchId: body.sender_batch_header.sender_batch_id, minor: toMinor(item.amount), currency: item.amount.currency, receiver: item.receiver });
      return json(201, { batch_header: header, links: [] });
    }
    m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const p = payoutById.get(m[1]);
      if (!p) return error(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      p.gets += 1;
      const item = p.body.items[0];
      const done = p.gets >= state.payoutGetsUntilSuccess;
      const fee = { currency: item.amount.currency, value: fmt(item.amount.currency, Math.round(toMinor(item.amount) * 0.02)) };
      return json(200, {
        batch_header: { ...p.body.header, batch_status: done ? "SUCCESS" : "PROCESSING", amount: item.amount, fees: fee },
        items: [
          {
            payout_item_id: `${m[1]}-I1`,
            transaction_id: done ? `${m[1]}-T1` : undefined,
            transaction_status: done ? "SUCCESS" : "PENDING",
            payout_item_fee: fee,
            payout_batch_id: m[1],
            payout_item: { recipient_type: "EMAIL", amount: item.amount, receiver: item.receiver, sender_item_id: item.sender_item_id },
          },
        ],
      });
    }
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      return json(200, { verification_status: body.transmission_sig === "valid-signature" ? "SUCCESS" : "FAILURE" });
    }
    return error(404, "NOT_FOUND", `fake sandbox has no ${method} ${path}`);
  }

  state.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "fake-token", token_type: "Bearer", expires_in: 32400 });
    const requestId = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1];
    const key = requestId ? `${init.method} ${u.pathname} ${requestId}` : null;
    if (key && seen.has(key)) {
      state.calls.push({ method: init.method, path: u.pathname, requestId, replayed: true });
      const s = seen.get(key)!;
      return new Response(s.body, { status: s.status === 201 ? 200 : s.status, headers: { "content-type": "application/json" } });
    }
    state.calls.push({ method: init.method, path: u.pathname, requestId, replayed: false });
    const f = init.method === "POST" ? failures.findIndex((x) => u.pathname.includes(x.pathPart)) : -1;
    const res = f >= 0 ? json(failures[f].status, failures.splice(f, 1)[0].body) : handle(init.method, u.pathname, init.body ? JSON.parse(init.body) : undefined);
    const text = await res.clone().text();
    if (key && res.status < 500) seen.set(key, { status: res.status, body: text });
    const last = state.captures.at(-1);
    if (last && !last.requestId && u.pathname.endsWith("/capture")) last.requestId = requestId ?? "";
    return res;
  };
  return state;
}
