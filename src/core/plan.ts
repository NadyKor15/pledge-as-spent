import { CoreError } from "./errors";
import type * as E from "./events";
import { captureRequestId, payoutSenderBatchId, reauthRequestId, voidRequestId } from "./ids";
import {
  availableMinor,
  type CaptureBatch,
  consecutiveFailures,
  type HoldBook,
  isLiveStatus,
  latestAuthorizationId,
  rootAuthorizationId,
  type LedgerState,
  lookup,
  needsVoid,
  pendingBatch,
  receiptFundedBase,
  requireDrive,
  requirePledge,
  unsettledHolds,
} from "./ledger";
import {
  CAPTURE_BEFORE_EXPIRY_MS,
  CAPTURE_RETRY_BASE_MS,
  dayIndex,
  HOLD_LIFE_DAYS,
  HOUR_MS,
  parseTime,
  REAUTH_FROM_DAY,
  RENEWAL_FROM_DAY,
} from "./time";
import type { Drive, Money, Pledge } from "./types";

// State + time -> commands. Planners never change state: the caller performs a
// command and records what happened as an event.

export interface CaptureOptions {
  /** The coordinator's "capture now" button; it also skips the wait after a refusal. */
  force?: boolean;
  /** A pending capture older than this is sent again with the same request id. Default 10. */
  retryAfterMinutes?: number;
}

const DEFAULT_RETRY_MINUTES = 10;

function captureCommand(
  drive: Drive,
  pledge: Pledge,
  hold: HoldBook,
  batch: Pick<CaptureBatch, "seq" | "amount" | "shares">,
  reasons: E.CaptureReason[],
  retry: boolean,
): E.CaptureCommand {
  return {
    kind: "capture",
    driveId: drive.id,
    pledgeId: pledge.id,
    authorizationId: latestAuthorizationId(hold),
    amount: { currency: pledge.amount.currency, minor: batch.amount },
    finalCapture: false,
    requestId: captureRequestId(drive.id, pledge.id, batch.seq),
    seq: batch.seq,
    shareIds: batch.shares.map((a) => a.shareId),
    reasons,
    retry,
  };
}

/** SPEC §4: which holds get a partial capture of everything accrued on them. */
export function planCaptures(s: LedgerState, now: string, opts: CaptureOptions = {}): E.CaptureCommand[] {
  const drive = requireDrive(s);
  const t = parseTime(now, "now");
  const retryMinutes = opts.retryAfterMinutes ?? DEFAULT_RETRY_MINUTES;
  if (!(retryMinutes >= 0)) throw new CoreError("invalid_state", "retryAfterMinutes must be >= 0");
  const out: E.CaptureCommand[] = [];
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    const hold = s.holds[id];
    const pending = pendingBatch(hold);
    if (pending) {
      // One capture in flight per hold; a stale one goes again under the same id.
      if (t - parseTime(pending.submittedAt) >= retryMinutes * 60_000) {
        out.push(captureCommand(drive, pledge, hold, pending, [], true));
      }
      continue;
    }
    if (hold.accrued <= 0 || hold.blockedAt || !isLiveStatus(pledge.status) || !pledge.expiresAt) continue;
    const expiresAt = parseTime(pledge.expiresAt);
    if (t >= expiresAt) continue; // too late to capture; maintenance expires it
    const refused = consecutiveFailures(hold);
    if (refused > 0 && !opts.force) {
      const last = hold.batches[hold.batches.length - 1];
      if (t < parseTime(last.resolvedAt ?? last.submittedAt) + CAPTURE_RETRY_BASE_MS * 2 ** (refused - 1)) continue;
    }
    const oldest = Math.min(...hold.accruals.map((a) => parseTime(a.at)));
    const threshold = drive.batch.thresholdMinor[pledge.amount.currency];
    const reasons: E.CaptureReason[] = [];
    if (t - oldest >= drive.batch.maxAgeHours * HOUR_MS) reasons.push("age");
    if (threshold !== undefined && hold.accrued >= threshold) reasons.push("threshold");
    if (expiresAt - t <= CAPTURE_BEFORE_EXPIRY_MS) reasons.push("expiry");
    if (drive.status !== "open") reasons.push("closing");
    if (hold.revokedAt) reasons.push("revoked");
    if (opts.force) reasons.push("force");
    if (reasons.length > 0) {
      out.push(captureCommand(drive, pledge, hold, { seq: hold.nextSeq, amount: hold.accrued, shares: hold.accruals }, reasons, false));
    }
  }
  return out;
}

/** The event to append when a capture command is sent (not for retries: those are already recorded). */
export function captureSubmittedEvent(cmd: E.CaptureCommand, at: string): E.CaptureSubmitted {
  return {
    id: `${cmd.requestId}:submitted`,
    at,
    driveId: cmd.driveId,
    type: "CaptureSubmitted",
    pledgeId: cmd.pledgeId,
    requestId: cmd.requestId,
    seq: cmd.seq,
    amount: { ...cmd.amount },
    shareIds: [...cmd.shareIds],
  };
}

function reauthBlocker(s: LedgerState, pledge: Pledge, hold: HoldBook, now: string): string | null {
  if (!isLiveStatus(pledge.status)) return `hold is ${pledge.status}`;
  if (hold.revokedAt) return "pledge was revoked";
  if (requireDrive(s).status !== "open") return "drive is closing";
  if (pledge.paymentSource !== "paypal") return "only PayPal-account holds can be reauthorized";
  const day = dayIndex(pledge.authorizedAt!, now);
  if (day < REAUTH_FROM_DAY) return `day ${day}: reauthorize opens on day ${REAUTH_FROM_DAY}`;
  if (day >= HOLD_LIFE_DAYS) return `day ${day}: the hold's ${HOLD_LIFE_DAYS} days are over`;
  if (pendingBatch(hold)) return "a capture is in flight";
  if (hold.authorized - hold.captured <= 0) return "nothing left to hold";
  return null;
}

function reauthorizeCommand(s: LedgerState, pledge: Pledge, hold: HoldBook, explicit: boolean): E.ReauthorizeCommand {
  const drive = requireDrive(s);
  const attempt = hold.reauths.length + 1;
  return {
    kind: "reauthorize",
    driveId: drive.id,
    pledgeId: pledge.id,
    authorizationId: rootAuthorizationId(hold),
    amount: { currency: pledge.amount.currency, minor: hold.authorized - hold.captured },
    requestId: reauthRequestId(drive.id, pledge.id, attempt),
    attempt,
    explicit,
  };
}

function voidCommand(drive: Drive, pledge: Pledge, hold: HoldBook, reason: E.VoidCommand["reason"]): E.VoidCommand {
  return {
    kind: "void",
    driveId: drive.id,
    pledgeId: pledge.id,
    authorizationId: rootAuthorizationId(hold),
    requestId: voidRequestId(drive.id, pledge.id),
    reason,
  };
}

/** Nothing accrued or in flight, donor money still held at PayPal: a void now loses nothing. */
const readyToVoid = (pledge: Pledge, hold: HoldBook): boolean =>
  needsVoid(pledge, hold) && hold.accrued === 0 && !pendingBatch(hold);

/**
 * SPEC §5: reauthorize once from day 4 (PayPal-account holds only), ask for a
 * renewal from day 26, expire on day 29, void a revoked hold once its accrued
 * shares are captured, void a hold whose capture was refused for good, and void
 * any hold still holding money once the drive is closing or closed (a donor may
 * approve after the close).
 */
export function planHoldMaintenance(s: LedgerState, now: string): E.MaintenanceCommand[] {
  const drive = requireDrive(s);
  const t = parseTime(now, "now");
  const out: E.MaintenanceCommand[] = [];
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    const hold = s.holds[id];
    if (!isLiveStatus(pledge.status) || !pledge.authorizedAt || !pledge.expiresAt) continue;
    if (t >= parseTime(pledge.expiresAt)) {
      out.push({ kind: "expire", driveId: drive.id, pledgeId: id });
      continue;
    }
    if (hold.revokedAt || hold.blockedAt) {
      if (readyToVoid(pledge, hold)) out.push(voidCommand(drive, pledge, hold, hold.blockedAt ? "capture_refused" : "revoked"));
      continue;
    }
    if (drive.status !== "open") {
      if (readyToVoid(pledge, hold)) out.push(voidCommand(drive, pledge, hold, "close"));
      continue;
    }
    if (hold.reauths.length === 0 && reauthBlocker(s, pledge, hold, now) === null) {
      out.push(reauthorizeCommand(s, pledge, hold, false));
    }
    const available = availableMinor(pledge, hold);
    if (!hold.renewalRequestedAt && available > 0 && dayIndex(pledge.authorizedAt, now) >= RENEWAL_FROM_DAY) {
      out.push({
        kind: "renewal_request",
        driveId: drive.id,
        pledgeId: id,
        available: { currency: pledge.amount.currency, minor: available },
        expiresAt: pledge.expiresAt,
      });
    }
  }
  return out;
}

/**
 * A reauthorize beyond the first, by hand: the endpoint description allows
 * several, the request schema says once, and this is how the finding is tested.
 */
export function planExplicitReauthorize(s: LedgerState, pledgeId: string, now: string): E.ReauthorizeCommand {
  parseTime(now, "now");
  const { pledge, hold } = requirePledge(s, pledgeId);
  const blocker = reauthBlocker(s, pledge, hold, now);
  if (blocker) throw new CoreError("invalid_state", `cannot reauthorize ${pledgeId}: ${blocker}`);
  return reauthorizeCommand(s, pledge, hold, true);
}

export function holdExpiredEvent(cmd: E.ExpireCommand, at: string): E.HoldExpired {
  return { id: `expire:${cmd.driveId}:${cmd.pledgeId}`, at, driveId: cmd.driveId, type: "HoldExpired", pledgeId: cmd.pledgeId };
}

export function renewalRequestedEvent(cmd: E.RenewalRequestCommand, at: string): E.RenewalRequested {
  return { id: `renewal:${cmd.driveId}:${cmd.pledgeId}`, at, driveId: cmd.driveId, type: "RenewalRequested", pledgeId: cmd.pledgeId };
}

/**
 * SPEC §6: capture everything accrued first; void a hold only once its
 * captures are confirmed; `close_drive` once nothing is left anywhere. On a
 * closed drive it still voids holds authorized after the close.
 */
export function planClose(s: LedgerState, now: string): E.CloseCommand[] {
  const drive = requireDrive(s);
  if (drive.status === "open") throw new CoreError("invalid_state", "record DriveClosing before planning the close");
  const t = parseTime(now, "now");
  const out: E.CloseCommand[] = [...planCaptures(s, now)];
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    const hold = s.holds[id];
    if (!isLiveStatus(pledge.status) || !pledge.expiresAt) continue;
    if (t >= parseTime(pledge.expiresAt)) out.push({ kind: "expire", driveId: drive.id, pledgeId: id });
    else if (readyToVoid(pledge, hold)) out.push(voidCommand(drive, pledge, hold, hold.blockedAt ? "capture_refused" : "close"));
  }
  if (drive.status === "closing" && out.length === 0 && unsettledHolds(s).length === 0) {
    out.push({ kind: "close_drive", driveId: drive.id });
  }
  return out;
}

/**
 * SPEC §7: the volunteer is paid the funded part of a receipt in the drive
 * currency; the holds guarantee it. Lines funded after a payout (a flagged line
 * approved later) are paid as a top-up. Null when nothing is owed.
 */
export function planPayout(s: LedgerState, receiptId: string): E.PayoutCommand | null {
  const drive = requireDrive(s);
  if (!s.lineKeys.some((k) => lineReceipt(s, k) === receiptId)) {
    throw new CoreError("unknown_receipt", `no lines of receipt ${receiptId} in the book`);
  }
  const attempts = lookup(s.payouts, receiptId) ?? [];
  const owed = receiptFundedBase(s, receiptId) - paidBase(attempts);
  const pendingIndex = attempts.findIndex((a) => a.status === "pending");
  if (owed <= 0 && pendingIndex < 0) return null;
  if (pendingIndex >= 0) {
    const a = attempts[pendingIndex];
    return {
      kind: "payout",
      driveId: drive.id,
      receiptId,
      senderBatchId: a.senderBatchId,
      amount: { currency: drive.baseCurrency, minor: a.amount },
      attempt: pendingIndex + 1,
      retry: true,
    };
  }
  const attempt = attempts.length + 1;
  return {
    kind: "payout",
    driveId: drive.id,
    receiptId,
    senderBatchId: payoutSenderBatchId(drive.id, receiptId, attempt),
    amount: { currency: drive.baseCurrency, minor: owed },
    attempt,
    retry: false,
  };
}

const paidBase = (attempts: { status: string; amount: number }[]): number =>
  attempts.filter((a) => a.status === "confirmed").reduce((acc, a) => acc + a.amount, 0);

function lineReceipt(s: LedgerState, key: string): string {
  const ev = s.lines[key].event;
  return ev.type === "LineFunded" ? ev.line.receiptId : ev.receiptId;
}

export function payoutSubmittedEvent(cmd: E.PayoutCommand, at: string): E.PayoutSubmitted {
  return {
    id: `${cmd.senderBatchId}:submitted`,
    at,
    driveId: cmd.driveId,
    type: "PayoutSubmitted",
    receiptId: cmd.receiptId,
    senderBatchId: cmd.senderBatchId,
    amount: { ...cmd.amount },
  };
}

export interface ReversalInput {
  /** PayPal's capture id, as webhooks carry it. */
  captureId: string;
  amount: Money;
  reason: string;
  at: string;
  /** PayPal's refund or reversal id, when known. */
  reversalId?: string;
  /** The event id to use; by default derived from the capture, amount and time. */
  id?: string;
}

/**
 * For the webhook handler: PAYMENT.CAPTURE.REVERSED / REFUNDED -> CaptureReversed,
 * found by capture id. Null when the capture is not a confirmed one in this book.
 */
export function captureReversedEvent(s: LedgerState, r: ReversalInput): E.CaptureReversed | null {
  const drive = requireDrive(s);
  parseTime(r.at, "at");
  for (const id of s.pledgeIds) {
    const b = s.holds[id].batches.find((x) => x.status === "confirmed" && x.captureId === r.captureId);
    if (!b) continue;
    return {
      id: r.id ?? `reversed:${b.requestId}:${r.reversalId ?? `${r.amount.minor}@${r.at}`}`,
      at: r.at,
      driveId: drive.id,
      type: "CaptureReversed",
      pledgeId: id,
      requestId: b.requestId,
      captureId: r.captureId,
      amount: { ...r.amount },
      reason: r.reason,
      ...(r.reversalId ? { reversalId: r.reversalId } : {}),
    };
  }
  return null;
}
