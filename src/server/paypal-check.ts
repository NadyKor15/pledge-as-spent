import { AsyncLocalStorage } from "node:async_hooks";
import { eq, asc } from "drizzle-orm";
import type { Db } from "../db/client";
import { paypalCalls } from "../db/schema";
import type { HoldStatus, LedgerState, Money } from "../core";
import { createPayPalGateway, GuardError, SANDBOX_BASE_URL } from "../paypal/gateway";
import { parsePayPalMoney } from "../paypal/money";
import type { FetchLike } from "../paypal/recording";
import type { PayPalGateway } from "../paypal/types";
import { readBook } from "./book";
import { ServiceError } from "./errors";
import { getService } from "./runtime";

// "Ask PayPal yourself": the drive's own PayPal objects, read back from PayPal's sandbox and laid next to what the
// book says about each one. Every hold (GET /v2/payments/authorizations/{id}), every capture
// (GET /v2/payments/captures/{id}) and every volunteer payout (GET /v1/payments/payouts/{batch}).
//
// Read-only by construction: the fetch under the gateway refuses every POST except PayPal's token exchange, and only
// the three GET calls are made. Nothing is written: not the book, not the journal of PayPal calls. The keys are the
// server's; the answer carries no token and hides the sandbox accounts' e-mail addresses and ids.

export type CheckKind = "authorization" | "capture" | "payout";

/** What the book says about one PayPal object, and which of PayPal's words agree with it. */
export interface BookSide {
  /** The book's own state, as a code the screen words: held, partly_captured, captured, voided, expired, denied, reauthorized, confirmed, pending, failed. */
  state: string;
  /** null: the book does not fix the amount (a reauthorization: PayPal decides what it re-holds). */
  amount: Money | null;
  /** PayPal's statuses that say the same thing. */
  agrees: string[];
  /** PayPal's statuses that are only ahead of the book: a webhook or lookup has not arrived yet. */
  ahead: string[];
}

export interface CheckObject {
  kind: CheckKind;
  id: string;
  /** Donor or company for holds and captures; the receipt for a payout. */
  who: string;
  pledgeId: string | null;
  receiptId: string | null;
  book: BookSide;
}

export interface PayPalSide {
  /** HTTP status of PayPal's answer; 0: no answer (network, timeout). */
  http: number;
  status: string | null;
  /** Payouts: the item's transaction status (the batch's is `status`). */
  itemStatus: string | null;
  amount: Money | null;
  /** PayPal's own times: create_time / update_time, or a payout batch's time_created / time_completed. */
  created: string | null;
  updated: string | null;
  debugId: string | null;
  /** When our server sent the GET, ISO UTC. */
  askedAt: string;
  ms: number;
  error: string | null;
}

export type Verdict = "agrees" | "differs" | "ahead" | "no_answer";

export interface CheckRow extends CheckObject {
  /** The request, e.g. "GET /v2/payments/captures/3WP65983GD053501C". */
  request: string;
  paypal: PayPalSide;
  verdict: Verdict;
  /** PayPal's JSON as it came, with the sandbox accounts' e-mail addresses and ids hidden. */
  raw: unknown;
}

export interface CheckResult {
  driveId: string;
  paypal: typeof SANDBOX_BASE_URL;
  method: string;
  /** When the server started asking PayPal, ISO UTC. A cached answer keeps its own time. */
  askedAt: string;
  answeredAt: string;
  cached: boolean;
  /** Seconds the answer is kept before PayPal is asked again. */
  keptForS: number;
  total: number;
  answered: number;
  agrees: number;
  rows: CheckRow[];
}

export interface CheckLimits {
  /** Fresh checks (PayPal asked) per network per hour; answers from the cache do not count. */
  checksPerHour: number;
  /** One drive's answer is kept this long. */
  cacheMs: number;
  /** One request to PayPal; a timed-out one is tried once more. */
  requestTimeoutMs: number;
  /** The whole check: objects without an answer by then are "PayPal didn't answer". */
  deadlineMs: number;
}

export const DEFAULT_CHECK_LIMITS: CheckLimits = { checksPerHour: 12, cacheMs: 60_000, requestTimeoutMs: 5_000, deadlineMs: 9_000 };

/** A row of the journal of PayPal calls: only what the check needs to find ids the book does not hold yet. */
export interface JournalCall {
  method: string;
  path: string;
  requestId: string | null;
  httpStatus: number;
  ids: Record<string, string>;
}

const READ_ONLY_METHOD = "GET only; the one POST is PayPal's token exchange";
const OK = Symbol("ok");
const LATE = Symbol("late");
const TOKEN_PATH = "/v1/oauth2/token";

// ---- what the book says ----------------------------------------------------------

const AUTH_AGREES: Record<HoldStatus, string[]> = {
  pending_approval: [],
  authorized: ["CREATED", "PENDING"],
  partially_captured: ["PARTIALLY_CAPTURED"],
  captured: ["CAPTURED"],
  voided: ["VOIDED"],
  // PayPal reports an expiry as a void too (src/core/ledger.ts onHoldEnded).
  expired: ["EXPIRED", "VOIDED"],
  denied: ["DENIED", "VOIDED"],
};

const AUTH_STATE: Record<HoldStatus, string> = {
  pending_approval: "pending_approval",
  authorized: "held",
  partially_captured: "partly_captured",
  captured: "captured",
  voided: "voided",
  expired: "expired",
  denied: "denied",
};

const receiptName = (id: string) => {
  const n = /\.r(\d+)$/.exec(id)?.[1];
  return n ? `receipt ${n}` : id;
};

/**
 * Every PayPal object of the drive the book knows of, with the book's word on it. Holds: each authorization id, the
 * original and any reauthorization. Captures: confirmed ones from the book, and ones PayPal accepted that the book
 * still waits on, from the journal. Payouts: each attempt's batch id, from the book or the journal.
 */
export function bookObjects(s: LedgerState, journal: JournalCall[] = []): CheckObject[] {
  const drive = s.drive;
  if (!drive) return [];
  const out: CheckObject[] = [];
  const seen = new Set<string>();
  const add = (o: CheckObject) => {
    if (!o.id || seen.has(`${o.kind}:${o.id}`)) return;
    seen.add(`${o.kind}:${o.id}`);
    out.push(o);
  };
  // The id PayPal gave a successful POST, by its request id.
  const answered = new Map<string, Record<string, string>>();
  for (const c of journal) if (c.method === "POST" && c.requestId && c.httpStatus >= 200 && c.httpStatus < 300) answered.set(c.requestId, c.ids);

  for (const pledgeId of s.pledgeIds) {
    const p = s.pledges[pledgeId];
    const h = s.holds[pledgeId];
    if (!h) continue;
    const live = p.status === "authorized" || p.status === "partially_captured";
    const pending = h.capturePending > 0;
    h.authorizationIds.forEach((id, i) => {
      const child = i > 0;
      const agrees = AUTH_AGREES[p.status];
      // A capture on its way, or a close on its way, can be at PayPal before its answer is in the book.
      const ahead = live ? (pending ? ["PARTIALLY_CAPTURED", "CAPTURED", "VOIDED"] : ["VOIDED"]) : [];
      add({
        kind: "authorization",
        id,
        who: p.donorName,
        pledgeId,
        receiptId: null,
        book: {
          state: child ? "reauthorized" : AUTH_STATE[p.status],
          amount: child ? null : p.amount,
          // A reauthorization's parent and child move together at PayPal (live probe 2026-10-31).
          agrees: child || h.authorizationIds.length > 1 ? [...new Set([...agrees, ...(live ? ["CREATED", "PARTIALLY_CAPTURED"] : [])])] : agrees,
          ahead,
        },
      });
    });
    for (const b of h.batches) {
      const captureId = b.captureId ?? answered.get(b.requestId)?.id;
      if (!captureId) continue;
      const amount = { currency: p.amount.currency, minor: b.amount };
      if (b.status === "confirmed") {
        const refunded = b.reversed > 0 ? (b.reversed >= b.amount ? ["REFUNDED"] : ["PARTIALLY_REFUNDED"]) : ["COMPLETED"];
        add({ kind: "capture", id: captureId, who: p.donorName, pledgeId, receiptId: null, book: { state: b.reversed > 0 ? "reversed" : "confirmed", amount, agrees: refunded, ahead: b.reversed > 0 ? [] : ["PARTIALLY_REFUNDED", "REFUNDED"] } });
      } else if (b.status === "pending") {
        add({ kind: "capture", id: captureId, who: p.donorName, pledgeId, receiptId: null, book: { state: "pending", amount, agrees: ["PENDING"], ahead: ["COMPLETED"] } });
      } else {
        add({ kind: "capture", id: captureId, who: p.donorName, pledgeId, receiptId: null, book: { state: "failed", amount, agrees: ["DECLINED", "FAILED"], ahead: [] } });
      }
    }
  }

  for (const receiptId of Object.keys(s.payouts)) {
    for (const a of s.payouts[receiptId]) {
      const batchId = a.payoutBatchId ?? answered.get(a.senderBatchId)?.payoutBatchId;
      if (!batchId || batchId === "-") continue;
      const amount = { currency: drive.baseCurrency, minor: a.amount };
      const book: BookSide =
        a.status === "confirmed"
          ? { state: "confirmed", amount, agrees: ["SUCCESS"], ahead: [] }
          : a.status === "pending"
            ? { state: "pending", amount, agrees: ["PENDING", "PROCESSING", "UNCLAIMED", "ONHOLD"], ahead: ["SUCCESS"] }
            : { state: "failed", amount, agrees: ["FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "REVERSED", "CANCELED"], ahead: [] };
      add({ kind: "payout", id: batchId, who: receiptName(receiptId), pledgeId: null, receiptId, book });
    }
  }
  return out;
}

// ---- PayPal's answer --------------------------------------------------------------

const PATH: Record<CheckKind, (id: string) => string> = {
  authorization: (id) => `/v2/payments/authorizations/${encodeURIComponent(id)}`,
  capture: (id) => `/v2/payments/captures/${encodeURIComponent(id)}`,
  payout: (id) => `/v1/payments/payouts/${encodeURIComponent(id)}`,
};

/** Sandbox accounts' e-mail addresses and ids, hidden from the published JSON. */
const ACCOUNT_KEYS = /^(email_address|receiver|merchant_id|payer_id|account_id|payer_email)$/;
export const HIDDEN = "(sandbox account, hidden)";

export function hideAccounts(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hideAccounts);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = ACCOUNT_KEYS.test(k) && (typeof x === "string" || typeof x === "number") ? HIDDEN : hideAccounts(x);
    return out;
  }
  return v;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const moneyOf = (raw: unknown): Money | null => {
  try {
    return parsePayPalMoney(raw);
  } catch {
    return null;
  }
};

/** The fields the table shows, from PayPal's JSON of one object. */
export function readAnswer(kind: CheckKind, body: unknown): Pick<PayPalSide, "status" | "itemStatus" | "amount" | "created" | "updated"> {
  const o = obj(body);
  if (kind !== "payout") {
    return { status: str(o.status), itemStatus: null, amount: moneyOf(o.amount), created: str(o.create_time), updated: str(o.update_time) };
  }
  const h = obj(o.batch_header);
  const item = obj(Array.isArray(o.items) ? o.items[0] : undefined);
  return {
    status: str(h.batch_status),
    itemStatus: str(item.transaction_status),
    amount: moneyOf(obj(item.payout_item).amount) ?? moneyOf(h.amount),
    created: str(h.time_created),
    updated: str(h.time_completed) ?? str(item.time_processed),
  };
}

const sameMoney = (a: Money | null, b: Money | null) => a !== null && b !== null && a.currency === b.currency && a.minor === b.minor;

/** Does PayPal's answer say what the book says? */
export function verdictOf(o: CheckObject, p: Pick<PayPalSide, "http" | "status" | "itemStatus" | "amount">): Verdict {
  if (p.http !== 200) return p.http === 0 ? "no_answer" : "differs";
  // A payout's money is in its item; the batch can stay PROCESSING after the item succeeded.
  const status = o.kind === "payout" ? (p.itemStatus ?? p.status) : p.status;
  if (!status) return "differs";
  if (o.book.amount !== null && !sameMoney(o.book.amount, p.amount)) return "differs";
  if (o.book.agrees.includes(status)) return "agrees";
  if (o.book.ahead.includes(status)) return "ahead";
  return "differs";
}

// ---- the check ----------------------------------------------------------------------

interface Captured {
  status: number;
  text: string;
  debugId: string | null;
}

/** One object's GET answers, by path, for the call that is running (concurrent checks do not mix). */
const answers = new AsyncLocalStorage<Map<string, Captured>>();

/** Under the gateway: refuses anything but GET and the token exchange, and keeps each GET's answer for the table. */
export function readOnlyFetch(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const method = init.method.toUpperCase();
    if (method !== "GET" && !(method === "POST" && u.pathname === TOKEN_PATH)) throw new GuardError(`The PayPal check only reads: refusing ${method} ${u.pathname}`);
    const res = await inner(url, init);
    const store = answers.getStore();
    if (store && method === "GET") store.set(u.pathname, { status: res.status, text: await res.clone().text(), debugId: res.headers.get("paypal-debug-id") });
    return res;
  };
}

export interface PayPalCheckDeps {
  /** The drive's book and its journal of PayPal calls; null for a drive that does not exist. */
  load(driveId: string): Promise<{ state: LedgerState; journal: JournalCall[] } | null>;
  /** The server's sandbox keys; null when this server has none. */
  keys: { clientId: string; clientSecret: string } | null;
  fetch?: FetchLike;
  hashIp(ip: string): string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  limits?: Partial<CheckLimits>;
}

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text.slice(0, 2000);
  }
};

export class PayPalCheck {
  readonly limits: CheckLimits;
  private gw?: PayPalGateway;
  private readonly cache = new Map<string, { at: number; result: CheckResult }>();
  private readonly inflight = new Map<string, Promise<CheckResult>>();
  /** Fresh checks per hashed address: times in ms, the last hour only. Kept in this process. */
  private readonly asked = new Map<string, number[]>();

  constructor(private readonly d: PayPalCheckDeps) {
    this.limits = { ...DEFAULT_CHECK_LIMITS, ...d.limits };
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private gateway(): PayPalGateway {
    if (!this.d.keys) throw new ServiceError(503, "paypal_not_configured", "PayPal sandbox keys are not configured on this server, so PayPal cannot be asked from here.");
    const inner: FetchLike = this.d.fetch ?? ((url, init) => fetch(url, init));
    this.gw ??= createPayPalGateway({
      clientId: this.d.keys.clientId,
      clientSecret: this.d.keys.clientSecret,
      fetch: readOnlyFetch(inner),
      timeoutMs: this.limits.requestTimeoutMs,
      maxRetries: 1,
      retryDelayMs: 300,
      now: () => this.now(),
    });
    return this.gw;
  }

  /** Forgets answers and addresses past their time, so a long-lived process does not keep them all. */
  private prune(t: number) {
    if (this.cache.size > 500) for (const [k, v] of this.cache) if (t - v.at >= this.limits.cacheMs) this.cache.delete(k);
    if (this.asked.size > 5000) for (const [k, v] of this.asked) if (!v.some((x) => t - x < 3_600_000)) this.asked.delete(k);
  }

  /** The drive's objects as PayPal answers them now, or as it answered in the last minute. */
  async run(driveId: string, ip: string): Promise<CheckResult> {
    const t = this.now();
    this.prune(t);
    const kept = this.cache.get(driveId);
    if (kept && t - kept.at < this.limits.cacheMs) return { ...kept.result, cached: true, keptForS: Math.max(0, Math.ceil((kept.at + this.limits.cacheMs - t) / 1000)) };
    const running = this.inflight.get(driveId);
    if (running) return running;

    const loaded = await this.d.load(driveId);
    if (!loaded) throw new ServiceError(404, "unknown_drive", `No drive ${driveId}.`);
    const objects = bookObjects(loaded.state, loaded.journal);
    if (objects.length === 0) throw new ServiceError(409, "nothing_at_paypal", "This drive has no PayPal objects yet: no hold has been approved.");
    const gw = this.gateway();

    const who = this.d.hashIp(ip || "unknown");
    const recent = (this.asked.get(who) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= this.limits.checksPerHour) {
      this.asked.set(who, recent);
      throw new ServiceError(429, "check_limit", `This network has asked PayPal ${this.limits.checksPerHour} times in the last hour. An answer is kept for a minute, so open it again then, or try later.`);
    }
    this.asked.set(who, [...recent, t]);

    const job = this.ask(driveId, objects, gw)
      .then((result) => {
        if (result.answered === 0) throw new ServiceError(504, "paypal_no_answer", "PayPal didn't answer. Try again in a moment.");
        // A partial answer is shown but not kept: the next press asks again.
        if (result.answered === result.total) this.cache.set(driveId, { at: t, result });
        return result;
      })
      .finally(() => this.inflight.delete(driveId));
    this.inflight.set(driveId, job);
    return job;
  }

  private async ask(driveId: string, objects: CheckObject[], gw: PayPalGateway): Promise<CheckResult> {
    const startedAt = new Date(this.now()).toISOString();
    const deadline = this.limits.deadlineMs;
    const one = async (o: CheckObject): Promise<CheckRow> => {
      const path = PATH[o.kind](o.id);
      const store = new Map<string, Captured>();
      const t0 = this.now();
      const askedAt = new Date(t0).toISOString();
      let error: string | null = null;
      let late = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineHit = new Promise<typeof LATE>((resolve) => {
        timer = setTimeout(() => resolve(LATE), deadline);
      });
      try {
        const call = answers.run(store, () => (o.kind === "authorization" ? gw.getAuthorization(o.id) : o.kind === "capture" ? gw.getCapture(o.id) : gw.getPayoutBatch(o.id)));
        // The gateway's own reading of the answer may refuse an odd shape: the table reads PayPal's JSON itself.
        const outcome = await Promise.race([call.then(() => OK, (e: unknown) => e), deadlineHit]);
        if (outcome === LATE) {
          late = true;
          error = "PayPal didn't answer in time.";
        } else if (outcome !== OK && !store.has(path)) error = outcome instanceof Error ? outcome.message : String(outcome);
      } finally {
        clearTimeout(timer);
      }
      const got = late ? undefined : store.get(path);
      const body = got ? parseJson(got.text) : null;
      const read = got ? readAnswer(o.kind, body) : { status: null, itemStatus: null, amount: null, created: null, updated: null };
      const paypal: PayPalSide = { http: got?.status ?? 0, ...read, debugId: got?.debugId ?? str(obj(body).debug_id), askedAt, ms: Math.max(0, this.now() - t0), error: got ? null : (error ?? "PayPal didn't answer.") };
      return { ...o, request: `GET ${path}`, paypal, verdict: verdictOf(o, paypal), raw: got ? hideAccounts(body) : null };
    };
    const rows = await Promise.all(objects.map(one));
    const answered = rows.filter((r) => r.paypal.http === 200).length;
    return {
      driveId,
      paypal: SANDBOX_BASE_URL,
      method: READ_ONLY_METHOD,
      askedAt: startedAt,
      answeredAt: new Date(this.now()).toISOString(),
      cached: false,
      keptForS: Math.round(this.limits.cacheMs / 1000),
      total: rows.length,
      answered,
      agrees: rows.filter((r) => r.verdict === "agrees").length,
      rows,
    };
  }
}

// ---- the server's one check -----------------------------------------------------------

/** The drive's book and the ids in its journal of PayPal calls. */
export async function loadForCheck(db: Db, driveId: string): Promise<{ state: LedgerState; journal: JournalCall[] } | null> {
  const state = await readBook(db, driveId);
  if (!state.drive) return null;
  const journal = await db
    .select({ method: paypalCalls.method, path: paypalCalls.path, requestId: paypalCalls.requestId, httpStatus: paypalCalls.httpStatus, ids: paypalCalls.ids })
    .from(paypalCalls)
    .where(eq(paypalCalls.driveId, driveId))
    .orderBy(asc(paypalCalls.id));
  return { state, journal };
}

/** PAYPAL_CHECKS_PER_HOUR: a judging panel can share one address. */
export function checkLimitsFrom(env: NodeJS.ProcessEnv): Partial<CheckLimits> {
  const v = env.PAYPAL_CHECKS_PER_HOUR;
  return v && /^\d+$/.test(v) && Number(v) > 0 ? { checksPerHour: Number(v) } : {};
}

const slot = globalThis as typeof globalThis & { __pledgePayPalCheck?: PayPalCheck };

/** One check per server process, with the same sandbox keys as the service (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET). */
export async function getPayPalCheck(): Promise<PayPalCheck> {
  if (slot.__pledgePayPalCheck) return slot.__pledgePayPalCheck;
  const svc = await getService();
  const env = process.env;
  const keys = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET } : null;
  slot.__pledgePayPalCheck ??= new PayPalCheck({ load: (id) => loadForCheck(svc.db, id), keys, hashIp: (ip) => svc.hashIp(ip), limits: checkLimitsFrom(env) });
  return slot.__pledgePayPalCheck;
}

/** Tests and the end-to-end server put their own check behind the route. */
export function setPayPalCheckForTests(c: PayPalCheck | undefined): void {
  slot.__pledgePayPalCheck = c;
}
