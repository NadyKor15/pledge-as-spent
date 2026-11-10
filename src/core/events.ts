import type { Drive, FundableLineInput, Money, Need, PaymentSource, Pledge, PledgeKind } from "./types";

// The drive's book is an append-only journal of these events. Every event has
// an id, so replaying an event the journal already holds is a no-op.

export interface EventBase {
  id: string;
  /** Zoned ISO date-time of the fact (PayPal's create_time where PayPal is the source). */
  at: string;
  driveId: string;
}

export interface DriveOpened extends EventBase {
  type: "DriveOpened";
  drive: Drive;
  needs: Need[];
}

export interface PledgeCreated extends EventBase {
  type: "PledgeCreated";
  pledge: Pledge;
}

export interface PledgeAuthorized extends EventBase {
  type: "PledgeAuthorized";
  pledgeId: string;
  authorizationId: string;
  paymentSource: PaymentSource;
}

export interface PledgeDenied extends EventBase {
  type: "PledgeDenied";
  pledgeId: string;
  reason?: string;
}

/** The donor withdrew: nothing new is funded from this hold; accrued shares are still captured, then voided. */
export interface PledgeRevoked extends EventBase {
  type: "PledgeRevoked";
  pledgeId: string;
}

export interface Share {
  pledgeId: string;
  kind: PledgeKind;
  /** Exact part of the line in the drive currency. Shares of a line sum to its funded amount. */
  base: number;
  /** What the hold is charged for it, in the pledge currency. */
  quote: Money;
  /** Donor shares: the part of the match this donor's money unlocked (base). 0 on match shares. */
  matchBase: number;
  /** false: funded after the hold's honor period, when PayPal no longer guarantees the funds. */
  honored?: boolean;
}

export interface LineFunded extends EventBase {
  type: "LineFunded";
  line: FundableLineInput;
  /** Units taken into work: the line's quantity, capped by what the need still lacks. */
  acceptedQty: number;
  /** Units (and their base amount) refused because the need is covered. */
  rejectedQty: number;
  rejectedBase: number;
  /** Funded by holds; donorBase + matchBase. */
  fundedBase: number;
  /** Accepted but not backed by pledges: the coordinator sees "not enough pledges for this need". */
  unfundedBase: number;
  donorBase: number;
  matchBase: number;
  /** Capacities the split saw, kept for audit. */
  donorCapacityBase: number;
  matchCapacityBase: number;
  matchRatio: { num: number; den: number } | null;
  shares: Share[];
}

export type CoreRejectCode = "need_covered" | "drive_closed";

export interface LineRejected extends EventBase {
  type: "LineRejected";
  receiptId: string;
  lineNo: number;
  needId: string | null;
  needQty: number | null;
  amountBase: number;
  /** Engine codes, or the receipts module's rule codes (alcohol, gift_card, ...). */
  code: CoreRejectCode | (string & {});
  reasonEn: string;
}

export interface CaptureSubmitted extends EventBase {
  type: "CaptureSubmitted";
  pledgeId: string;
  requestId: string;
  seq: number;
  amount: Money;
  shareIds: string[];
}

/** Only from a verified webhook. */
export interface CaptureConfirmed extends EventBase {
  type: "CaptureConfirmed";
  pledgeId: string;
  requestId: string;
  captureId: string;
  amount: Money;
  /** seller_receivable_breakdown.paypal_fee, when PayPal sent it. */
  paypalFee?: Money;
}

/**
 * PayPal refused the capture. A timeout is not a failure: retry with the same
 * request id. The reason is classified (classifyCaptureFailure): a terminal one,
 * or the last allowed attempt, sends the hold's shares to uncollected.
 */
export interface CaptureFailed extends EventBase {
  type: "CaptureFailed";
  pledgeId: string;
  requestId: string;
  reason: string;
  /** Overrides the classification of `reason` when the caller knows better. */
  terminal?: boolean;
}

/** Money PayPal took back after a confirmed capture: refund, chargeback, reversal. */
export interface CaptureReversed extends EventBase {
  type: "CaptureReversed";
  pledgeId: string;
  requestId: string;
  captureId: string;
  amount: Money;
  reason: string;
  /** PayPal's refund or reversal id, when known: the same one is never counted twice. */
  reversalId?: string;
}

/**
 * The donor moved what is left of a hold from one need to another, before the
 * close (one press on the statement). PayPal is not called: the same
 * authorization, for the same amount and the same 29 days, now backs the new
 * need. Shares already funded stay on the old need's lines; from this event on
 * the hold funds only the new need. One per hold.
 */
export interface PledgeRebound extends EventBase {
  type: "PledgeRebound";
  pledgeId: string;
  /** The need the donor saw the hold on; a stale press is refused. */
  fromNeedId: string;
  toNeedId: string;
  /** The donor's consent, recorded with the event's time. */
  consent: { by: string; via: string };
}

/**
 * The donor chose "keep the rest for this drive's next purchases" at the pledge.
 * Their need is covered, so what is left of the hold now backs the open need
 * that lacks the most (ties: the drive's order). PayPal is not called, as with
 * PledgeRebound; unlike it, this follows a rule and may happen once per need left.
 */
export interface RestCarried extends EventBase {
  type: "RestCarried";
  pledgeId: string;
  /** The covered need the hold backed. */
  fromNeedId: string;
  /** The need the rule picked; any other is refused. */
  toNeedId: string;
  /** The consent is the donor's choice at the pledge. */
  consent: { by: string; via: "pledge_choice" };
}

/**
 * The renewal `pledgeId` (approved) now carries on hold `fromPledgeId`. From this
 * event on the old hold funds nothing new: what it has accrued is captured, then
 * it is voided. The new hold may promise at most what the old one had not promised
 * at this moment; the rest of the new authorization is never used (its surplus,
 * let go at the void). Appended right after the renewal's authorization.
 */
export interface PledgeRenewed extends EventBase {
  type: "PledgeRenewed";
  pledgeId: string;
  fromPledgeId: string;
}

export interface Reauthorized extends EventBase {
  type: "Reauthorized";
  pledgeId: string;
  requestId: string;
  /** May be a NEW authorization id; every later command goes to it. */
  authorizationId: string;
}

export interface RenewalRequested extends EventBase {
  type: "RenewalRequested";
  pledgeId: string;
}

export interface HoldVoided extends EventBase {
  type: "HoldVoided";
  pledgeId: string;
}

export interface HoldExpired extends EventBase {
  type: "HoldExpired";
  pledgeId: string;
}

export interface PayoutSubmitted extends EventBase {
  type: "PayoutSubmitted";
  receiptId: string;
  senderBatchId: string;
  amount: Money;
}

/** Only from a verified webhook. */
export interface PayoutConfirmed extends EventBase {
  type: "PayoutConfirmed";
  receiptId: string;
  senderBatchId: string;
  payoutBatchId: string;
  fee?: Money;
}

export interface PayoutFailed extends EventBase {
  type: "PayoutFailed";
  receiptId: string;
  senderBatchId: string;
  reason: string;
}

export interface DriveClosing extends EventBase {
  type: "DriveClosing";
}

export interface DriveClosed extends EventBase {
  type: "DriveClosed";
}

export type LedgerEvent =
  | DriveOpened
  | PledgeCreated
  | PledgeAuthorized
  | PledgeDenied
  | PledgeRevoked
  | PledgeRebound
  | RestCarried
  | PledgeRenewed
  | LineFunded
  | LineRejected
  | CaptureSubmitted
  | CaptureConfirmed
  | CaptureFailed
  | CaptureReversed
  | Reauthorized
  | RenewalRequested
  | HoldVoided
  | HoldExpired
  | PayoutSubmitted
  | PayoutConfirmed
  | PayoutFailed
  | DriveClosing
  | DriveClosed;

export type LedgerEventType = LedgerEvent["type"];

// Commands are what the planners ask the PayPal side to do. They carry the
// PayPal-Request-Id (or sender_batch_id) so a retry cannot act twice.

export type CaptureReason = "age" | "threshold" | "expiry" | "closing" | "force" | "revoked" | "renewed";

export interface CaptureCommand {
  kind: "capture";
  driveId: string;
  pledgeId: string;
  /** Latest id in the hold's authorization chain. */
  authorizationId: string;
  amount: Money;
  finalCapture: false;
  requestId: string;
  seq: number;
  shareIds: string[];
  reasons: CaptureReason[];
  /** true: the same batch again after a timeout, same request id. */
  retry: boolean;
}

export interface ReauthorizeCommand {
  kind: "reauthorize";
  driveId: string;
  pledgeId: string;
  authorizationId: string;
  /** What is still uncaptured on the hold. */
  amount: Money;
  requestId: string;
  attempt: number;
  /** A reauthorize beyond the first one, asked for by hand. */
  explicit: boolean;
}

export interface RenewalRequestCommand {
  kind: "renewal_request";
  driveId: string;
  pledgeId: string;
  available: Money;
  expiresAt: string;
}

export interface ExpireCommand {
  kind: "expire";
  driveId: string;
  pledgeId: string;
}

export interface VoidCommand {
  kind: "void";
  driveId: string;
  pledgeId: string;
  authorizationId: string;
  requestId: string;
  /** renewed: carried on by a renewal, or a renewal with nothing left to fund; renewal_unlinked: an approved renewal that can never be linked. */
  reason: "close" | "revoked" | "capture_refused" | "renewed" | "renewal_unlinked";
}

export interface PayoutCommand {
  kind: "payout";
  driveId: string;
  receiptId: string;
  senderBatchId: string;
  amount: Money;
  attempt: number;
  retry: boolean;
}

export interface CloseDriveCommand {
  kind: "close_drive";
  driveId: string;
}

export type MaintenanceCommand = ReauthorizeCommand | RenewalRequestCommand | ExpireCommand | VoidCommand;
export type CloseCommand = CaptureCommand | ExpireCommand | VoidCommand | CloseDriveCommand;
export type Command = CaptureCommand | MaintenanceCommand | PayoutCommand | CloseDriveCommand;
