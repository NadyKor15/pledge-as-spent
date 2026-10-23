import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchLike } from "../paypal/recording";

// Every PayPal exchange is written to paypal_calls: method, path, request id,
// HTTP status, debug id and the ids in the response. No headers other than the
// request id, no bodies, so no token or secret can land there.

export interface AuditEntry {
  ts: string;
  method: string;
  path: string;
  requestId: string | null;
  httpStatus: number;
  debugId: string | null;
  ids: Record<string, string>;
}

interface Scope {
  entries: AuditEntry[];
}

const scope = new AsyncLocalStorage<Scope>();

const TOKEN_PATH = "/v1/oauth2/token";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** The identifiers worth keeping from a PayPal response body. */
export function extractIds(body: unknown): Record<string, string> {
  const o = obj(body);
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (typeof v === "string" && v) out[k] = v;
  };
  put("id", o.id);
  put("status", o.status);
  put("invoiceId", o.invoice_id);
  put("customId", o.custom_id);
  put("verificationStatus", o.verification_status);
  put("errorName", o.name);
  put("issue", obj(Array.isArray(o.details) ? o.details[0] : undefined).issue);
  put("debugId", o.debug_id);
  const unit = obj(Array.isArray(o.purchase_units) ? o.purchase_units[0] : undefined);
  const auth = obj(Array.isArray(obj(unit.payments).authorizations) ? (obj(unit.payments).authorizations as unknown[])[0] : undefined);
  put("authorizationId", auth.id);
  put("authorizationStatus", auth.status);
  const header = obj(o.batch_header);
  put("payoutBatchId", header.payout_batch_id);
  put("batchStatus", header.batch_status);
  const item = obj(Array.isArray(o.items) ? o.items[0] : undefined);
  put("payoutItemId", item.payout_item_id);
  put("transactionId", item.transaction_id);
  put("transactionStatus", item.transaction_status);
  return out;
}

/** Wraps the fetch the gateway uses; entries go to the scope opened by `collectCalls`. */
export function auditingFetch(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    if (u.pathname === TOKEN_PATH) return inner(url, init);
    const s = scope.getStore();
    const requestId = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1] ?? null;
    const base = { ts: new Date().toISOString(), method: init.method.toUpperCase(), path: u.pathname, requestId };
    let res: Response;
    try {
      res = await inner(url, init);
    } catch (e) {
      s?.entries.push({ ...base, httpStatus: 0, debugId: null, ids: { error: String((e as Error)?.name ?? "error") } });
      throw e;
    }
    if (s) {
      let ids: Record<string, string> = {};
      try {
        ids = extractIds(JSON.parse(await res.clone().text()));
      } catch {
        // non-JSON body (gateway HTML, empty 204): status only
      }
      s.entries.push({ ...base, httpStatus: res.status, debugId: res.headers.get("paypal-debug-id") ?? ids.debugId ?? null, ids });
    }
    return res;
  };
}

/** Runs `fn`, returning its result together with the PayPal exchanges it made (also when it throws). */
export async function collectCalls<T>(fn: () => Promise<T>, onDone: (entries: AuditEntry[]) => Promise<void>): Promise<T> {
  const s: Scope = { entries: [] };
  try {
    return await scope.run(s, fn);
  } finally {
    if (s.entries.length) await onDone(s.entries);
  }
}
