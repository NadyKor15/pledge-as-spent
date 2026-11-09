import { CoreError } from "./errors";
import type * as E from "./events";
import { captureRequestId, lineKeyOf, payoutSenderBatchId, reauthRequestId, shareIdOf } from "./ids";
import { assertMinor, currencyExponent, toBase, validateFx } from "./money";
import { classifyCaptureFailure, MAX_CAPTURE_ATTEMPTS } from "./refusals";
import { largestRemainder } from "./split";
import { addMs, DAY_MS, HOLD_LIFE_DAYS, HONOR_DAYS, parseTime, REBIND_BEFORE_EXPIRY_MS } from "./time";
import type { Drive, HoldStatus, Need, Pledge } from "./types";

// The book of one drive: state + event -> state. Deterministic, never mutates
// its input, and ignores an event whose id it has already applied.

export interface Accrual {
  shareId: string;
  lineKey: string;
  /** Pledge-currency minor units still to be captured. */
  minor: number;
  at: string;
}

export interface CaptureBatch {
  seq: number;
  requestId: string;
  amount: number;
  shares: Accrual[];
  status: "pending" | "confirmed" | "failed";
  submittedAt: string;
  resolvedAt?: string;
  captureId?: string;
  paypalFeeMinor?: number;
  failReason?: string;
  /** The refusal ended capturing on this hold. */
  terminal?: boolean;
  /** Taken back by PayPal after confirmation (refund, chargeback). */
  reversed: number;
  reversedByShare: Record<string, number>;
  reversals: { amount: number; reason: string; at: string; reversalId?: string }[];
}

export interface HoldBook {
  pledgeId: string;
  authorized: number;
  captured: number;
  capturePending: number;
  accrued: number;
  /** Let go by PayPal (void, expiry) without being promised to any line. */
  released: number;
  /** Promised to lines but never captured: the hold ended, or PayPal refused for good. Not charged. */
  uncollected: number;
  /** Captured, then taken back by PayPal. Not charged. */
  reversed: number;
  uncollectedReasons: Record<string, string>;
  accruals: Accrual[];
  batches: CaptureBatch[];
  nextSeq: number;
  /** Oldest first; commands always go to the last one. */
  authorizationIds: string[];
  reauths: { requestId: string; authorizationId: string; at: string }[];
  uncollectedShareIds: string[];
  renewalRequestedAt?: string;
  revokedAt?: string;
  /** A capture was refused for good: nothing more is funded or captured; the hold waits for its void. */
  blockedAt?: string;
  blockedReason?: string;
  endedAt?: string;
  /** The donor moved the rest of this hold to another need (once). */
  rebound?: HoldRebind;
}

export interface HoldRebind {
  at: string;
  fromNeedId: string;
  toNeedId: string;
  by: string;
  via: string;
}

export interface LineRecord {
  key: string;
  event: E.LineFunded | E.LineRejected;
}

export interface PayoutAttempt {
  senderBatchId: string;
  amount: number;
  status: "pending" | "confirmed" | "failed";
  submittedAt: string;
  payoutBatchId?: string;
  fee?: { currency: string; minor: number };
  failReason?: string;
}

export interface LedgerState {
  drive: Drive | null;
  needs: Record<string, Need>;
  needIds: string[];
  qtyCovered: Record<string, number>;
  pledges: Record<string, Pledge>;
  pledgeIds: string[];
  holds: Record<string, HoldBook>;
  lines: Record<string, LineRecord>;
  lineKeys: string[];
  payouts: Record<string, PayoutAttempt[]>;
  seen: Record<string, true>;
}

export const emptyLedger = (): LedgerState => ({
  drive: null,
  needs: {},
  needIds: [],
  qtyCovered: {},
  pledges: {},
  pledgeIds: [],
  holds: {},
  lines: {},
  lineKeys: [],
  payouts: {},
  seen: {},
});

/** Own-property lookup: ids like "constructor" must not hit Object.prototype. */
export function lookup<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

// ---- hold arithmetic -------------------------------------------------------

const LIVE: ReadonlySet<HoldStatus> = new Set<HoldStatus>(["authorized", "partially_captured"]);

export const isLiveStatus = (status: HoldStatus): boolean => LIVE.has(status);

/**
 * Money still held at PayPal and promised to no line. Every hold satisfies
 * authorized = captured + capturePending + accrued + uncollected + reversed + released + uncommitted.
 */
export const uncommitted = (h: HoldBook): number =>
  h.authorized - h.captured - h.capturePending - h.accrued - h.uncollected - h.reversed - h.released;

/** What new lines may draw on: 0 unless the hold is live, not revoked and not blocked. */
export function availableMinor(p: Pledge, h: HoldBook): number {
  return isLiveStatus(p.status) && !h.revokedAt && !h.blockedAt ? uncommitted(h) : 0;
}

/** A live hold that still keeps donor money at PayPal which no capture will take: it needs a void. */
export function needsVoid(p: Pledge, h: HoldBook): boolean {
  return isLiveStatus(p.status) && (uncommitted(h) > 0 || (Boolean(h.blockedAt) && h.uncollected > 0));
}

/** Refused batches since the hold's last confirmed one. */
export function consecutiveFailures(h: HoldBook): number {
  let n = 0;
  for (let i = h.batches.length - 1; i >= 0 && h.batches[i].status === "failed"; i--) n += 1;
  return n;
}

/** Base amount the remaining hold is guaranteed to cover. */
export function capacityBase(p: Pledge, h: HoldBook): number {
  return toBase(availableMinor(p, h), p.fx, "floor");
}

/** Live, not revoked, not past its 29-day life at `nowIso`, with something left. */
export function isFundable(p: Pledge, h: HoldBook, nowIso: string): boolean {
  if (availableMinor(p, h) <= 0 || !p.expiresAt) return false;
  return parseTime(nowIso) < parseTime(p.expiresAt);
}

export const pendingBatch = (h: HoldBook): CaptureBatch | undefined => h.batches.find((b) => b.status === "pending");

export function latestAuthorizationId(h: HoldBook): string {
  const id = h.authorizationIds[h.authorizationIds.length - 1];
  if (!id) throw new CoreError("invalid_state", `hold ${h.pledgeId} has no authorization`);
  return id;
}

/**
 * The first authorization of a hold. PayPal voids and reauthorizes through it:
 * a reauthorization id answers CANNOT_BE_VOIDED and REAUTHORIZATION_NOT_SUPPORTED,
 * and a void of the parent ends the reauthorization too (live probe 2026-10-31).
 */
export function rootAuthorizationId(h: HoldBook): string {
  const id = h.authorizationIds[0];
  if (!id) throw new CoreError("invalid_state", `hold ${h.pledgeId} has no authorization`);
  return id;
}

export function requireDrive(s: LedgerState): Drive {
  if (!s.drive) throw new CoreError("unknown_drive", "no DriveOpened event yet");
  return s.drive;
}

export function requirePledge(s: LedgerState, pledgeId: string): { pledge: Pledge; hold: HoldBook } {
  const pledge = lookup(s.pledges, pledgeId);
  const hold = lookup(s.holds, pledgeId);
  if (!pledge || !hold) throw new CoreError("unknown_pledge", `no pledge ${pledgeId}`);
  return { pledge, hold };
}

/** The drive's match ratio, fixed by its first match pledge; null without one. */
export function matchRatio(s: LedgerState): { num: number; den: number } | null {
  for (const id of s.pledgeIds) {
    const p = s.pledges[id];
    if (p.kind === "match" && p.match) return { num: p.match.ratioNum, den: p.match.ratioDen };
  }
  return null;
}

// ---- rebind -----------------------------------------------------------------

export type RebindRefusalCode =
  | "drive_not_open"
  | "unknown_pledge"
  | "not_donor"
  | "already_rebound"
  | "stale_need"
  | "unknown_need"
  | "same_need"
  | "hold_not_live"
  | "revoked"
  | "blocked"
  | "expired"
  | "too_close_to_expiry"
  | "nothing_left"
  | "need_covered";

export interface RebindRefusal {
  code: RebindRefusalCode;
  reasonEn: string;
}

/**
 * Why the rest of hold `pledgeId` may not move to need `toNeedId` at `at`, or
 * null when it may. The reducer and the statement's offer both ask this one
 * function, so the button never offers what the book would refuse.
 * `fromNeedId`: the need the donor saw the hold on (a stale screen is refused).
 */
export function rebindRefusal(s: LedgerState, pledgeId: string, toNeedId: string, at: string, fromNeedId?: string): RebindRefusal | null {
  const no = (code: RebindRefusalCode, reasonEn: string): RebindRefusal => ({ code, reasonEn });
  const drive = requireDrive(s);
  if (drive.status !== "open") return no("drive_not_open", `The drive is ${drive.status}; a pledge can no longer move to another need.`);
  const pledge = lookup(s.pledges, pledgeId);
  const hold = lookup(s.holds, pledgeId);
  if (!pledge || !hold) return no("unknown_pledge", `There is no pledge ${pledgeId} in this drive.`);
  if (pledge.kind !== "donor") return no("not_donor", "The company match backs the whole drive; it follows the donors and does not move.");
  if (hold.rebound) return no("already_rebound", `This pledge already moved once, to ${hold.rebound.toNeedId}.`);
  if (fromNeedId !== undefined && pledge.needId !== fromNeedId) return no("stale_need", `This pledge backs ${pledge.needId}, not ${fromNeedId}.`);
  const target = lookup(s.needs, toNeedId);
  if (!target) return no("unknown_need", `This drive has no need ${toNeedId}.`);
  if (pledge.needId === toNeedId) return no("same_need", `This pledge already backs ${target.label}.`);
  if (!isLiveStatus(pledge.status)) return no("hold_not_live", `The hold is ${pledge.status}; nothing is held for a new need.`);
  if (hold.revokedAt) return no("revoked", "The pledge was withdrawn.");
  if (hold.blockedAt) return no("blocked", "PayPal refused a charge on this hold for good.");
  if (!pledge.expiresAt || parseTime(at) >= parseTime(pledge.expiresAt)) return no("expired", "The hold has expired.");
  if (parseTime(at) >= parseTime(pledge.expiresAt) - REBIND_BEFORE_EXPIRY_MS) {
    return no("too_close_to_expiry", "The hold expires within 3 days; there is no time left to fund another need from it.");
  }
  if (availableMinor(pledge, hold) <= 0) return no("nothing_left", "Nothing is left on this hold.");
  if (s.qtyCovered[target.id] >= target.qtyNeeded) return no("need_covered", `${target.label} is already covered.`);
  return null;
}

// ---- reducer ----------------------------------------------------------------

export function replay(events: readonly E.LedgerEvent[], from: LedgerState = emptyLedger()): LedgerState {
  return events.reduce(applyEvent, from);
}

export function applyEvent(state: LedgerState, event: E.LedgerEvent): LedgerState {
  if (!event || typeof event.id !== "string" || event.id === "") {
    throw new CoreError("invalid_event", "event without an id");
  }
  if (lookup(state.seen, event.id)) return state;
  parseTime(event.at, `${event.type} ${event.id}: at`);
  if (typeof event.driveId !== "string" || event.driveId === "") {
    throw new CoreError("invalid_event", `${event.id}: missing driveId`);
  }
  if (event.type !== "DriveOpened") {
    const drive = requireDrive(state);
    if (event.driveId !== drive.id) {
      throw new CoreError("invalid_event", `${event.id}: belongs to drive ${event.driveId}, this book is ${drive.id}`);
    }
  }
  const next = reduce(state, event);
  if (next === state) return state; // semantic repeat (same line, same capture...): leave the book untouched
  return { ...next, seen: { ...next.seen, [event.id]: true } };
}

function reduce(s: LedgerState, e: E.LedgerEvent): LedgerState {
  switch (e.type) {
    case "DriveOpened":
      return onDriveOpened(s, e);
    case "PledgeCreated":
      return onPledgeCreated(s, e);
    case "PledgeAuthorized":
      return onPledgeAuthorized(s, e);
    case "PledgeDenied":
      return onPledgeDenied(s, e);
    case "PledgeRevoked":
      return onPledgeRevoked(s, e);
    case "PledgeRebound":
      return onPledgeRebound(s, e);
    case "LineFunded":
      return onLineFunded(s, e);
    case "LineRejected":
      return onLineRejected(s, e);
    case "CaptureSubmitted":
      return onCaptureSubmitted(s, e);
    case "CaptureConfirmed":
      return onCaptureConfirmed(s, e);
    case "CaptureFailed":
      return onCaptureFailed(s, e);
    case "CaptureReversed":
      return onCaptureReversed(s, e);
    case "Reauthorized":
      return onReauthorized(s, e);
    case "RenewalRequested":
      return onRenewalRequested(s, e);
    case "HoldVoided":
      return onHoldEnded(s, e, "voided");
    case "HoldExpired":
      return onHoldEnded(s, e, "expired");
    case "PayoutSubmitted":
      return onPayoutSubmitted(s, e);
    case "PayoutConfirmed":
      return onPayoutResolved(s, e, "confirmed");
    case "PayoutFailed":
      return onPayoutResolved(s, e, "failed");
    case "DriveClosing":
      return onDriveClosing(s);
    case "DriveClosed":
      return onDriveClosed(s);
    default: {
      const unknown: never = e;
      throw new CoreError("invalid_event", `unknown event type ${(unknown as { type: string }).type}`);
    }
  }
}

const fail = (e: E.EventBase & { type: string }, msg: string): never => {
  throw new CoreError("invalid_event", `${e.type} ${e.id}: ${msg}`);
};

const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const isNonNegInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function putHold(s: LedgerState, h: HoldBook): LedgerState {
  return { ...s, holds: { ...s.holds, [h.pledgeId]: h } };
}

function putPledge(s: LedgerState, p: Pledge): LedgerState {
  return { ...s, pledges: { ...s.pledges, [p.id]: p } };
}

function requireOpen(s: LedgerState, e: E.EventBase & { type: string }): Drive {
  const drive = requireDrive(s);
  if (drive.status !== "open") fail(e, `drive is ${drive.status}`);
  return drive;
}

function onDriveOpened(s: LedgerState, e: E.DriveOpened): LedgerState {
  if (s.drive) fail(e, `drive ${s.drive.id} is already open in this book`);
  const d = e.drive;
  if (!d || d.id !== e.driveId) fail(e, "drive.id must equal driveId");
  if (d.status !== "open") fail(e, "a drive opens with status open");
  currencyExponent(d.baseCurrency);
  if (!(typeof d.batch?.maxAgeHours === "number" && d.batch.maxAgeHours > 0)) fail(e, "batch.maxAgeHours must be > 0");
  for (const [cur, v] of Object.entries(d.batch.thresholdMinor ?? {})) {
    currencyExponent(cur);
    if (!isPositiveInt(v)) fail(e, `batch threshold for ${cur} must be a positive integer`);
  }
  const needs: Record<string, Need> = {};
  const qty: Record<string, number> = {};
  for (const n of e.needs) {
    if (!nonEmpty(n.id) || lookup(needs, n.id)) fail(e, `need id ${n.id} missing or repeated`);
    if (n.driveId !== d.id) fail(e, `need ${n.id} belongs to drive ${n.driveId}`);
    if (!isPositiveInt(n.qtyNeeded)) fail(e, `need ${n.id}: qtyNeeded must be a positive whole number`);
    needs[n.id] = n;
    qty[n.id] = 0;
  }
  return { ...s, drive: d, needs, needIds: e.needs.map((n) => n.id), qtyCovered: qty };
}

function onPledgeCreated(s: LedgerState, e: E.PledgeCreated): LedgerState {
  const drive = requireOpen(s, e);
  const p = e.pledge;
  if (!p || !nonEmpty(p.id)) fail(e, "pledge without id");
  if (lookup(s.pledges, p.id)) fail(e, `pledge ${p.id} already exists`);
  if (p.driveId !== drive.id) fail(e, `pledge belongs to drive ${p.driveId}`);
  if (p.status !== "pending_approval") fail(e, "a pledge starts as pending_approval");
  currencyExponent(p.amount.currency);
  if (!isPositiveInt(p.amount.minor)) fail(e, "amount must be a positive integer of minor units");
  validateFx(p.fx);
  if (p.fx.base !== drive.baseCurrency) fail(e, `fx.base ${p.fx.base} must be the drive currency ${drive.baseCurrency}`);
  if (p.fx.quote !== p.amount.currency) fail(e, `fx.quote ${p.fx.quote} must be the pledge currency ${p.amount.currency}`);
  if (!nonEmpty(p.paypal?.orderId)) fail(e, "paypal.orderId is required");
  if (p.kind === "donor") {
    if (p.needId === null || !lookup(s.needs, p.needId)) fail(e, `donor pledge must back a need of this drive`);
    if (p.match) fail(e, "a donor pledge has no match ratio");
  } else if (p.kind === "match") {
    if (p.needId !== null) fail(e, "a match pledge backs the whole drive (needId null)");
    if (!p.match || !isPositiveInt(p.match.ratioNum) || !isPositiveInt(p.match.ratioDen)) {
      fail(e, "match ratio must be two positive integers");
    }
    const r = matchRatio(s);
    if (r && r.num * p.match!.ratioDen !== p.match!.ratioNum * r.den) {
      fail(e, `match ratio ${p.match!.ratioNum}/${p.match!.ratioDen} differs from the drive's ${r.num}/${r.den}`);
    }
  } else {
    fail(e, `unknown pledge kind ${(p as Pledge).kind}`);
  }
  const hold: HoldBook = {
    pledgeId: p.id,
    authorized: 0,
    captured: 0,
    capturePending: 0,
    accrued: 0,
    released: 0,
    uncollected: 0,
    reversed: 0,
    uncollectedReasons: {},
    accruals: [],
    batches: [],
    nextSeq: 1,
    authorizationIds: [],
    reauths: [],
    uncollectedShareIds: [],
  };
  const next = putHold(putPledge(s, p), hold);
  return { ...next, pledgeIds: [...s.pledgeIds, p.id] };
}

function onPledgeAuthorized(s: LedgerState, e: E.PledgeAuthorized): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (!nonEmpty(e.authorizationId)) fail(e, "authorizationId is required");
  if (e.paymentSource !== "paypal" && e.paymentSource !== "card") fail(e, "paymentSource must be paypal or card");
  if (pledge.status !== "pending_approval") {
    if (hold.authorizationIds[0] === e.authorizationId) return s;
    fail(e, `pledge ${pledge.id} is ${pledge.status}`);
  }
  const p: Pledge = {
    ...pledge,
    status: "authorized",
    authorizedAt: e.at,
    honorUntil: addMs(e.at, HONOR_DAYS * DAY_MS),
    expiresAt: addMs(e.at, HOLD_LIFE_DAYS * DAY_MS),
    paypal: { ...pledge.paypal, authorizationId: e.authorizationId },
    paymentSource: e.paymentSource,
  };
  return putHold(putPledge(s, p), { ...hold, authorized: pledge.amount.minor, authorizationIds: [e.authorizationId] });
}

function onPledgeDenied(s: LedgerState, e: E.PledgeDenied): LedgerState {
  const { pledge } = requirePledge(s, e.pledgeId);
  if (pledge.status === "denied") return s;
  if (pledge.status !== "pending_approval") fail(e, `pledge ${pledge.id} is ${pledge.status}`);
  return putPledge(s, { ...pledge, status: "denied" });
}

function onPledgeRevoked(s: LedgerState, e: E.PledgeRevoked): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (hold.revokedAt) return s;
  if (!isLiveStatus(pledge.status) && pledge.status !== "pending_approval") {
    fail(e, `pledge ${pledge.id} is ${pledge.status}`);
  }
  return putHold(s, { ...hold, revokedAt: e.at });
}

function onPledgeRebound(s: LedgerState, e: E.PledgeRebound): LedgerState {
  if (!nonEmpty(e.pledgeId) || !nonEmpty(e.fromNeedId) || !nonEmpty(e.toNeedId)) fail(e, "pledgeId, fromNeedId and toNeedId are required");
  if (!e.consent || !nonEmpty(e.consent.by) || !nonEmpty(e.consent.via)) fail(e, "the donor's consent (by, via) is required");
  const hold = lookup(s.holds, e.pledgeId);
  const done = hold?.rebound;
  if (done && done.fromNeedId === e.fromNeedId && done.toNeedId === e.toNeedId) return s; // the same press again
  const refusal = rebindRefusal(s, e.pledgeId, e.toNeedId, e.at, e.fromNeedId);
  if (refusal) fail(e, `${refusal.code}: ${refusal.reasonEn}`);
  const { pledge } = requirePledge(s, e.pledgeId);
  const rebound: HoldRebind = { at: e.at, fromNeedId: e.fromNeedId, toNeedId: e.toNeedId, by: e.consent.by, via: e.consent.via };
  return putHold(putPledge(s, { ...pledge, needId: e.toNeedId }), { ...hold!, rebound });
}

function onLineFunded(s: LedgerState, e: E.LineFunded): LedgerState {
  const line = e.line;
  if (!line || !nonEmpty(line.receiptId) || !isPositiveInt(line.lineNo)) fail(e, "line needs receiptId and lineNo");
  const key = lineKeyOf(line.receiptId, line.lineNo);
  if (lookup(s.lines, key)) return s;
  requireOpen(s, e);
  const need = lookup(s.needs, line.needId);
  if (!need) fail(e, `unknown need ${line.needId}`);
  if (!isPositiveInt(line.needQty) || !isNonNegInt(line.amountBase)) fail(e, "line quantity/amount invalid");
  const remaining = need!.qtyNeeded - s.qtyCovered[need!.id];
  if (!isPositiveInt(e.acceptedQty) || e.acceptedQty > remaining) {
    fail(e, `accepted ${e.acceptedQty} but the need lacks ${remaining}`);
  }
  if (e.acceptedQty + e.rejectedQty !== line.needQty) fail(e, "accepted + rejected quantity must equal the line");
  for (const k of ["rejectedBase", "fundedBase", "unfundedBase", "donorBase", "matchBase"] as const) {
    if (!isNonNegInt(e[k])) fail(e, `${k} must be a non-negative integer`);
  }
  if (e.fundedBase + e.unfundedBase + e.rejectedBase !== line.amountBase) fail(e, "funded + unfunded + rejected must equal the line");
  if (e.donorBase + e.matchBase !== e.fundedBase) fail(e, "donor + match must equal funded");

  let next = s;
  let sumBase = 0;
  let sumDonor = 0;
  let sumAttributed = 0;
  const seenPledges = new Set<string>();
  for (const sh of e.shares) {
    const { pledge, hold } = requirePledge(next, sh.pledgeId);
    if (seenPledges.has(pledge.id)) fail(e, `two shares on pledge ${pledge.id}`);
    seenPledges.add(pledge.id);
    if (sh.kind !== pledge.kind) fail(e, `share kind ${sh.kind} on a ${pledge.kind} pledge`);
    if (pledge.kind === "donor" && pledge.needId !== line.needId) fail(e, `pledge ${pledge.id} backs another need`);
    if (!isFundable(pledge, hold, e.at)) fail(e, `pledge ${pledge.id} cannot fund lines now`);
    if (!isPositiveInt(sh.base) || sh.base > capacityBase(pledge, hold)) fail(e, `share base on ${pledge.id} exceeds its capacity`);
    if (sh.quote.currency !== pledge.amount.currency || !isNonNegInt(sh.quote.minor)) fail(e, `share quote on ${pledge.id} invalid`);
    if (sh.quote.minor > availableMinor(pledge, hold)) fail(e, `share on ${pledge.id} exceeds the hold`);
    if (!isNonNegInt(sh.matchBase) || (pledge.kind === "match" && sh.matchBase !== 0)) fail(e, "invalid match attribution");
    sumBase += sh.base;
    if (pledge.kind === "donor") sumDonor += sh.base;
    sumAttributed += sh.matchBase;
    if (sh.quote.minor > 0) {
      const accrual: Accrual = { shareId: shareIdOf(key, pledge.id), lineKey: key, minor: sh.quote.minor, at: e.at };
      next = putHold(next, { ...hold, accrued: hold.accrued + sh.quote.minor, accruals: [...hold.accruals, accrual] });
    }
  }
  if (sumBase !== e.fundedBase || sumDonor !== e.donorBase) fail(e, "shares do not add up to the funded amounts");
  if (sumAttributed !== e.matchBase) fail(e, "match attribution does not add up to the match");
  const r = matchRatio(s);
  const overRatio = r
    ? BigInt(e.matchBase) * BigInt(r.den) > BigInt(e.donorBase) * BigInt(r.num)
    : e.matchBase !== 0;
  if (overRatio) fail(e, "match exceeds ratio x donor money");
  return {
    ...next,
    qtyCovered: { ...next.qtyCovered, [need!.id]: next.qtyCovered[need!.id] + e.acceptedQty },
    lines: { ...next.lines, [key]: { key, event: e } },
    lineKeys: [...next.lineKeys, key],
  };
}

function onLineRejected(s: LedgerState, e: E.LineRejected): LedgerState {
  if (!nonEmpty(e.receiptId) || !isPositiveInt(e.lineNo)) fail(e, "line needs receiptId and lineNo");
  const key = lineKeyOf(e.receiptId, e.lineNo);
  if (lookup(s.lines, key)) return s;
  if (!isNonNegInt(e.amountBase)) fail(e, "amountBase must be a non-negative integer");
  if (!nonEmpty(e.code)) fail(e, "a rejection needs a code");
  if (e.needId !== null && !lookup(s.needs, e.needId)) fail(e, `unknown need ${e.needId}`);
  return { ...s, lines: { ...s.lines, [key]: { key, event: e } }, lineKeys: [...s.lineKeys, key] };
}

function onCaptureSubmitted(s: LedgerState, e: E.CaptureSubmitted): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (hold.batches.some((b) => b.requestId === e.requestId)) return s;
  if (!isLiveStatus(pledge.status)) fail(e, `hold is ${pledge.status}`);
  if (pendingBatch(hold)) fail(e, "another capture of this hold is still pending");
  if (e.seq !== hold.nextSeq) fail(e, `expected batch seq ${hold.nextSeq}, got ${e.seq}`);
  if (e.requestId !== captureRequestId(s.drive!.id, pledge.id, e.seq)) fail(e, "requestId does not match cap:{driveId}:{pledgeId}:{seq}");
  if (!Array.isArray(e.shareIds) || e.shareIds.length === 0) fail(e, "a batch needs at least one share");
  const wanted = new Set(e.shareIds);
  if (wanted.size !== e.shareIds.length) fail(e, "repeated share id");
  const taken = hold.accruals.filter((a) => wanted.has(a.shareId));
  if (taken.length !== wanted.size) fail(e, "batch names shares that are not accrued on this hold");
  const amount = taken.reduce((acc, a) => acc + a.minor, 0);
  if (e.amount.currency !== pledge.amount.currency || e.amount.minor !== amount) {
    fail(e, `batch amount must be ${amount} ${pledge.amount.currency}`);
  }
  const batch: CaptureBatch = {
    seq: e.seq,
    requestId: e.requestId,
    amount,
    shares: taken,
    status: "pending",
    submittedAt: e.at,
    reversed: 0,
    reversedByShare: {},
    reversals: [],
  };
  return putHold(s, {
    ...hold,
    accrued: hold.accrued - amount,
    capturePending: hold.capturePending + amount,
    accruals: hold.accruals.filter((a) => !wanted.has(a.shareId)),
    batches: [...hold.batches, batch],
    nextSeq: hold.nextSeq + 1,
  });
}

function findBatch(e: E.CaptureConfirmed | E.CaptureFailed, hold: HoldBook): CaptureBatch {
  const b = hold.batches.find((x) => x.requestId === e.requestId);
  if (!b) fail(e, `no capture ${e.requestId} on hold ${hold.pledgeId}`);
  return b!;
}

function replaceBatch(hold: HoldBook, b: CaptureBatch): CaptureBatch[] {
  return hold.batches.map((x) => (x.requestId === b.requestId ? b : x));
}

function onCaptureConfirmed(s: LedgerState, e: E.CaptureConfirmed): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  const b = findBatch(e, hold);
  if (!nonEmpty(e.captureId)) fail(e, "captureId is required");
  if (b.status === "confirmed") {
    if (b.captureId === e.captureId) return s;
    fail(e, `capture ${e.requestId} was confirmed as ${b.captureId}`);
  }
  if (b.status === "failed") fail(e, `capture ${e.requestId} was recorded as failed`);
  if (e.amount.currency !== pledge.amount.currency || e.amount.minor !== b.amount) {
    fail(e, `confirmed amount differs from the batch (${b.amount} ${pledge.amount.currency})`);
  }
  let feeMinor: number | undefined;
  if (e.paypalFee) {
    if (e.paypalFee.currency !== pledge.amount.currency) fail(e, "fee in another currency");
    assertMinor(e.paypalFee.minor, "paypalFee");
    feeMinor = e.paypalFee.minor;
  }
  const nb: CaptureBatch = { ...b, status: "confirmed", resolvedAt: e.at, captureId: e.captureId, paypalFeeMinor: feeMinor };
  const nh: HoldBook = {
    ...hold,
    capturePending: hold.capturePending - b.amount,
    captured: hold.captured + b.amount,
    batches: replaceBatch(hold, nb),
  };
  const status: HoldStatus = isLiveStatus(pledge.status)
    ? nh.captured + nh.reversed >= nh.authorized
      ? "captured"
      : "partially_captured"
    : pledge.status;
  return putHold(putPledge(s, { ...pledge, status }), nh);
}

/** Moves shares to uncollected, remembering why. */
function uncollect(h: HoldBook, shares: Accrual[], reason: string): Pick<HoldBook, "uncollected" | "uncollectedShareIds" | "uncollectedReasons"> {
  const reasons = { ...h.uncollectedReasons };
  for (const a of shares) reasons[a.shareId] = reason;
  return {
    uncollected: h.uncollected + shares.reduce((acc, a) => acc + a.minor, 0),
    uncollectedShareIds: [...h.uncollectedShareIds, ...shares.map((a) => a.shareId)],
    uncollectedReasons: reasons,
  };
}

function onCaptureFailed(s: LedgerState, e: E.CaptureFailed): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  const b = findBatch(e, hold);
  if (b.status === "failed") return s;
  if (b.status === "confirmed") fail(e, `capture ${e.requestId} was already confirmed (record a reversal with CaptureReversed)`);
  if (e.terminal !== undefined && typeof e.terminal !== "boolean") fail(e, "terminal must be a boolean");
  const reasonText = String(e.reason ?? "");
  const cls = classifyCaptureFailure(reasonText);
  const failedBatch: CaptureBatch = { ...b, status: "failed", resolvedAt: e.at, failReason: reasonText };
  // Counted with this batch already failed: it is the newest batch of the hold.
  const exhausted = consecutiveFailures({ ...hold, batches: replaceBatch(hold, failedBatch) }) >= MAX_CAPTURE_ATTEMPTS;
  const terminal = e.terminal ?? (cls.terminal || exhausted);
  const nb: CaptureBatch = terminal ? { ...failedBatch, terminal: true } : failedBatch;
  const base: HoldBook = { ...hold, capturePending: hold.capturePending - b.amount, batches: replaceBatch(hold, nb) };
  if (!isLiveStatus(pledge.status)) {
    return putHold(s, { ...base, ...uncollect(hold, b.shares, `capture refused after the hold ended: ${cls.code ?? reasonText}`) });
  }
  if (!terminal) {
    // Back to accrued with their original dates; the planner retries after a backoff.
    const accruals = [...b.shares, ...hold.accruals].sort((x, y) => parseTime(x.at) - parseTime(y.at));
    return putHold(s, { ...base, accrued: hold.accrued + b.amount, accruals });
  }
  // Refused for good: this hold will not be captured again, so nothing accrued on it can be collected.
  const why = cls.terminal || e.terminal ? (cls.code ?? reasonText) : `${MAX_CAPTURE_ATTEMPTS} refused attempts: ${cls.code ?? reasonText}`;
  return putHold(s, {
    ...base,
    ...uncollect(hold, [...b.shares, ...hold.accruals], why),
    accrued: 0,
    accruals: [],
    blockedAt: e.at,
    blockedReason: why,
  });
}

function onCaptureReversed(s: LedgerState, e: E.CaptureReversed): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  const b = hold.batches.find((x) => x.requestId === e.requestId);
  if (!b) fail(e, `no capture ${e.requestId} on hold ${hold.pledgeId}`);
  if (e.reversalId && b!.reversals.some((r) => r.reversalId === e.reversalId)) return s;
  if (b!.status !== "confirmed") fail(e, `capture ${e.requestId} is ${b!.status}, not confirmed`);
  if (e.captureId !== b!.captureId) fail(e, `capture ${e.requestId} was confirmed as ${b!.captureId}, not ${e.captureId}`);
  if (e.amount.currency !== pledge.amount.currency || !isPositiveInt(e.amount.minor)) fail(e, "reversal amount must be positive, in the hold's currency");
  if (e.amount.minor > b!.amount - b!.reversed) fail(e, `reverses more than was captured and not yet reversed (${b!.amount - b!.reversed})`);
  // Spread over the batch's shares by what each still has captured, so every share knows its part.
  const left = b!.shares.map((a) => ({ id: a.shareId, weight: a.minor - (b!.reversedByShare[a.shareId] ?? 0) }));
  const byShare = { ...b!.reversedByShare };
  for (const part of largestRemainder(e.amount.minor, left)) byShare[part.id] = (byShare[part.id] ?? 0) + part.amount;
  const nb: CaptureBatch = {
    ...b!,
    reversed: b!.reversed + e.amount.minor,
    reversedByShare: byShare,
    reversals: [...b!.reversals, { amount: e.amount.minor, reason: String(e.reason ?? ""), at: e.at, ...(e.reversalId ? { reversalId: e.reversalId } : {}) }],
  };
  return putHold(s, {
    ...hold,
    captured: hold.captured - e.amount.minor,
    reversed: hold.reversed + e.amount.minor,
    batches: replaceBatch(hold, nb),
  });
}

function onReauthorized(s: LedgerState, e: E.Reauthorized): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (hold.reauths.some((r) => r.requestId === e.requestId)) return s;
  if (!isLiveStatus(pledge.status)) fail(e, `hold is ${pledge.status}`);
  if (!nonEmpty(e.authorizationId)) fail(e, "authorizationId is required");
  const attempt = hold.reauths.length + 1;
  if (e.requestId !== reauthRequestId(s.drive!.id, pledge.id, attempt)) {
    fail(e, `requestId must be reauth:{driveId}:{pledgeId}:${attempt}`);
  }
  const chain = hold.authorizationIds[hold.authorizationIds.length - 1] === e.authorizationId
    ? hold.authorizationIds
    : [...hold.authorizationIds, e.authorizationId];
  const p: Pledge = {
    ...pledge,
    reauthorizedAt: e.at,
    honorUntil: addMs(e.at, HONOR_DAYS * DAY_MS),
    paypal: { ...pledge.paypal, authorizationId: e.authorizationId },
  };
  return putHold(putPledge(s, p), {
    ...hold,
    authorizationIds: chain,
    reauths: [...hold.reauths, { requestId: e.requestId, authorizationId: e.authorizationId, at: e.at }],
  });
}

function onRenewalRequested(s: LedgerState, e: E.RenewalRequested): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (hold.renewalRequestedAt) return s;
  if (!isLiveStatus(pledge.status)) fail(e, `hold is ${pledge.status}`);
  return putHold(s, { ...hold, renewalRequestedAt: e.at });
}

function onHoldEnded(s: LedgerState, e: E.HoldVoided | E.HoldExpired, status: "voided" | "expired"): LedgerState {
  const { pledge, hold } = requirePledge(s, e.pledgeId);
  if (pledge.status === "voided" || pledge.status === "expired") return s; // PayPal reports expiry as a void too
  if (pledge.status === "captured") fail(e, "a fully captured hold cannot be voided");
  if (pledge.status === "denied") fail(e, "a denied pledge has no hold");
  const nh: HoldBook = {
    ...hold,
    ...uncollect(hold, hold.accruals, `hold ${status}`),
    released: hold.released + uncommitted(hold),
    accrued: 0,
    accruals: [],
    endedAt: e.at,
  };
  return putHold(putPledge(s, { ...pledge, status }), nh);
}

/** Base amount the volunteer is owed for a receipt: its funded lines. */
export function receiptFundedBase(s: LedgerState, receiptId: string): number {
  let total = 0;
  for (const key of s.lineKeys) {
    const ev = s.lines[key].event;
    if (ev.type === "LineFunded" && ev.line.receiptId === receiptId) total += ev.fundedBase;
  }
  return total;
}

function onPayoutSubmitted(s: LedgerState, e: E.PayoutSubmitted): LedgerState {
  const drive = requireDrive(s);
  const attempts = lookup(s.payouts, e.receiptId) ?? [];
  if (attempts.some((a) => a.senderBatchId === e.senderBatchId)) return s;
  if (attempts.some((a) => a.status === "pending")) fail(e, `receipt ${e.receiptId} already has a payout in flight`);
  const expectedId = payoutSenderBatchId(drive.id, e.receiptId, attempts.length + 1);
  if (e.senderBatchId !== expectedId) fail(e, `senderBatchId must be ${expectedId}`);
  // Lines funded after a confirmed payout are paid as a top-up of the difference.
  const paid = attempts.filter((a) => a.status === "confirmed").reduce((acc, a) => acc + a.amount, 0);
  const owed = receiptFundedBase(s, e.receiptId) - paid;
  if (owed <= 0) fail(e, `receipt ${e.receiptId} has no funded lines left to pay`);
  if (e.amount.currency !== drive.baseCurrency || e.amount.minor !== owed) {
    fail(e, `payout must be ${owed} ${drive.baseCurrency}`);
  }
  const attempt: PayoutAttempt = { senderBatchId: e.senderBatchId, amount: owed, status: "pending", submittedAt: e.at };
  return { ...s, payouts: { ...s.payouts, [e.receiptId]: [...attempts, attempt] } };
}

function onPayoutResolved(s: LedgerState, e: E.PayoutConfirmed | E.PayoutFailed, status: "confirmed" | "failed"): LedgerState {
  const attempts = lookup(s.payouts, e.receiptId) ?? [];
  const a = attempts.find((x) => x.senderBatchId === e.senderBatchId);
  if (!a) fail(e, `no payout ${e.senderBatchId}`);
  if (a!.status === status) return s;
  if (a!.status !== "pending") fail(e, `payout ${e.senderBatchId} is already ${a!.status}`);
  let resolved: PayoutAttempt;
  if (e.type === "PayoutConfirmed") {
    if (!nonEmpty(e.payoutBatchId)) fail(e, "payoutBatchId is required");
    if (e.fee) assertMinor(e.fee.minor, "fee");
    resolved = { ...a!, status, payoutBatchId: e.payoutBatchId, fee: e.fee ? { ...e.fee } : undefined };
  } else {
    resolved = { ...a!, status, failReason: String(e.reason ?? "") };
  }
  const next = attempts.map((x) => (x.senderBatchId === e.senderBatchId ? resolved : x));
  return { ...s, payouts: { ...s.payouts, [e.receiptId]: next } };
}

function onDriveClosing(s: LedgerState): LedgerState {
  const drive = requireDrive(s);
  if (drive.status === "closing") return s;
  if (drive.status === "closed") throw new CoreError("invalid_event", "drive is already closed");
  return { ...s, drive: { ...drive, status: "closing" } };
}

/** Holds that still have money at PayPal or in flight; a drive closes only without them. */
export function unsettledHolds(s: LedgerState): string[] {
  return s.pledgeIds.filter((id) => {
    const h = s.holds[id];
    return h.capturePending > 0 || h.accrued > 0 || needsVoid(s.pledges[id], h);
  });
}

function onDriveClosed(s: LedgerState): LedgerState {
  const drive = requireDrive(s);
  if (drive.status === "closed") return s;
  if (drive.status !== "closing") throw new CoreError("invalid_event", "close the drive with DriveClosing first");
  const open = unsettledHolds(s);
  if (open.length > 0) throw new CoreError("invalid_event", `holds not settled: ${open.join(", ")}`);
  return { ...s, drive: { ...drive, status: "closed" } };
}
