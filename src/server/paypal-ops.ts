import type { CaptureCommand, LedgerEvent, PayoutCommand, ReauthorizeCommand, VoidCommand } from "../core";
import { PayPalError } from "../paypal/errors";
import type { CaptureResult, PayoutBatchResult, PayPalGateway } from "../paypal/types";
import type { EventSource } from "./book";

// One PayPal call per core command, and the ledger event PayPal's answer
// justifies. A capture or payout PayPal accepted is not recorded as done:
// "captured" and "paid" come only from a verified webhook or a lookup.

export type PayPalCommand = CaptureCommand | PayoutCommand | VoidCommand | ReauthorizeCommand;

export interface Recorded {
  event: LedgerEvent;
  source: EventSource;
}

export interface CommandReport {
  kind: PayPalCommand["kind"];
  pledgeId?: string;
  receiptId?: string;
  requestId: string;
  /** sent: PayPal accepted, waiting for confirmation; done: recorded; refused: PayPal said no; pending: no answer, retried later. */
  outcome: "sent" | "done" | "refused" | "pending";
  detail?: string;
  ids?: Record<string, string>;
  errors?: string[];
}

export interface Outcome {
  events: Recorded[];
  report: CommandReport;
}

/** PayPal refused the request itself (as opposed to a timeout or an outage). */
export function isRefusal(e: unknown): e is PayPalError {
  return e instanceof PayPalError && [400, 404, 422].includes(e.httpStatus);
}

export const describe = (e: PayPalError) => [e.httpStatus, e.name, e.issue].filter(Boolean).join(" ") + (e.debugId ? ` (debug_id ${e.debugId})` : "");

const captureEventIds = (requestId: string) => ({ confirmed: `${requestId}:confirmed`, failed: `${requestId}:failed` });

/** A capture as PayPal reports it -> CaptureConfirmed / CaptureFailed, or null while PayPal has not decided. */
export function captureEvent(
  c: CaptureResult,
  batch: { driveId: string; pledgeId: string; requestId: string },
  at: string,
  source: EventSource,
): Recorded | null {
  const ids = captureEventIds(batch.requestId);
  const base = { driveId: batch.driveId, pledgeId: batch.pledgeId, requestId: batch.requestId };
  if (["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(c.status)) {
    return {
      source,
      event: {
        ...base,
        id: ids.confirmed,
        type: "CaptureConfirmed",
        at: c.createTime ?? at,
        captureId: c.id,
        amount: c.amount,
        ...(c.sellerReceivable?.paypalFee ? { paypalFee: c.sellerReceivable.paypalFee } : {}),
      },
    };
  }
  if (["DECLINED", "FAILED"].includes(c.status)) {
    return { source, event: { ...base, id: ids.failed, type: "CaptureFailed", at, reason: `capture ${c.id} ${c.status}` } };
  }
  return null;
}

const PAYOUT_FAILED = new Set(["FAILED", "BLOCKED", "RETURNED", "UNCLAIMED", "DENIED", "REFUNDED", "REVERSED", "CANCELED"]);

/** A payout batch as PayPal reports it -> PayoutConfirmed / PayoutFailed, or null while it is in progress. */
export function payoutEvent(
  b: PayoutBatchResult,
  p: { driveId: string; receiptId: string; senderBatchId: string },
  at: string,
  source: EventSource,
): Recorded | null {
  const status = b.items[0]?.transactionStatus ?? (b.batchStatus === "DENIED" || b.batchStatus === "CANCELED" ? b.batchStatus : null);
  const base = { driveId: p.driveId, receiptId: p.receiptId, senderBatchId: p.senderBatchId };
  if (status === "SUCCESS") {
    return {
      source,
      event: {
        ...base,
        id: `${p.senderBatchId}:confirmed`,
        type: "PayoutConfirmed",
        at,
        payoutBatchId: b.payoutBatchId,
        ...(b.fees ? { fee: b.fees } : {}),
      },
    };
  }
  if (status && PAYOUT_FAILED.has(status)) {
    return { source, event: { ...base, id: `${p.senderBatchId}:failed`, type: "PayoutFailed", at, reason: `payout ${b.payoutBatchId} ${status}` } };
  }
  return null;
}

export interface PerformContext {
  now: string;
  driveTitle: string;
  payoutEmail: string | null;
}

export async function perform(gw: PayPalGateway, cmd: PayPalCommand, ctx: PerformContext): Promise<Outcome> {
  const at = ctx.now;
  switch (cmd.kind) {
    case "capture": {
      const report: CommandReport = { kind: "capture", pledgeId: cmd.pledgeId, requestId: cmd.requestId, outcome: "sent" };
      try {
        const c = await gw.captureAuthorization({
          authorizationId: cmd.authorizationId,
          amount: cmd.amount,
          finalCapture: false,
          requestId: cmd.requestId,
          // invoice_id comes back on the capture and its webhooks: it ties them to this batch.
          invoiceId: cmd.requestId,
          noteToPayer: `${cmd.shareIds.length} approved receipt line(s) for ${ctx.driveTitle}`,
        });
        report.ids = { captureId: c.id, status: c.status };
        const failed = ["DECLINED", "FAILED"].includes(c.status) ? captureEvent(c, cmd, at, "paypal_response") : null;
        if (failed) return { events: [failed], report: { ...report, outcome: "refused", detail: c.status } };
        return { events: [], report };
      } catch (e) {
        if (isRefusal(e)) {
          const event: LedgerEvent = { id: `${cmd.requestId}:failed`, type: "CaptureFailed", at, driveId: cmd.driveId, pledgeId: cmd.pledgeId, requestId: cmd.requestId, reason: describe(e) };
          return { events: [{ event, source: "paypal_response" }], report: { ...report, outcome: "refused", detail: describe(e) } };
        }
        if (e instanceof PayPalError) return { events: [], report: { ...report, outcome: "pending", detail: describe(e) } };
        throw e;
      }
    }
    case "payout": {
      const report: CommandReport = { kind: "payout", receiptId: cmd.receiptId, requestId: cmd.senderBatchId, outcome: "sent" };
      if (!ctx.payoutEmail) return { events: [], report: { ...report, outcome: "pending", detail: "the drive has no payout email" } };
      try {
        const b = await gw.createPayout({
          senderBatchId: cmd.senderBatchId,
          emailSubject: `Reimbursement for your receipt (${ctx.driveTitle})`,
          items: [{ senderItemId: cmd.senderBatchId, receiverEmail: ctx.payoutEmail, amount: cmd.amount, note: `Receipt ${cmd.receiptId}: the approved lines, paid from donors' holds.` }],
        });
        report.ids = { payoutBatchId: b.payoutBatchId, batchStatus: b.batchStatus };
        const done = payoutEvent(b, cmd, at, "paypal_response");
        if (done?.event.type === "PayoutFailed") return { events: [done], report: { ...report, outcome: "refused", detail: b.batchStatus } };
        return { events: [], report };
      } catch (e) {
        // A reused sender_batch_id means the payout may already exist: wait for the lookup, never pay twice.
        if (isRefusal(e) && !/DUPLICATE|ALREADY/i.test(`${e.name} ${e.issue ?? ""} ${e.message}`)) {
          const event: LedgerEvent = { id: `${cmd.senderBatchId}:failed`, type: "PayoutFailed", at, driveId: cmd.driveId, receiptId: cmd.receiptId, senderBatchId: cmd.senderBatchId, reason: describe(e) };
          return { events: [{ event, source: "paypal_response" }], report: { ...report, outcome: "refused", detail: describe(e) } };
        }
        if (e instanceof PayPalError) return { events: [], report: { ...report, outcome: "pending", detail: describe(e) } };
        throw e;
      }
    }
    case "void": {
      const report: CommandReport = { kind: "void", pledgeId: cmd.pledgeId, requestId: cmd.requestId, outcome: "done" };
      const voided: LedgerEvent = { id: `voided:${cmd.driveId}:${cmd.pledgeId}`, type: "HoldVoided", at, driveId: cmd.driveId, pledgeId: cmd.pledgeId };
      try {
        await gw.voidAuthorization({ authorizationId: cmd.authorizationId, requestId: cmd.requestId });
        return { events: [{ event: voided, source: "paypal_response" }], report };
      } catch (e) {
        const text = e instanceof PayPalError ? `${e.name} ${e.issue ?? ""}` : "";
        if (isRefusal(e) && /VOIDED/i.test(text)) return { events: [{ event: voided, source: "paypal_response" }], report: { ...report, detail: describe(e) } };
        if (isRefusal(e) && /EXPIRED/i.test(text)) {
          const expired: LedgerEvent = { id: `expire:${cmd.driveId}:${cmd.pledgeId}`, type: "HoldExpired", at, driveId: cmd.driveId, pledgeId: cmd.pledgeId };
          return { events: [{ event: expired, source: "paypal_response" }], report: { ...report, detail: describe(e) } };
        }
        if (e instanceof PayPalError) return { events: [], report: { ...report, outcome: isRefusal(e) ? "refused" : "pending", detail: describe(e) } };
        throw e;
      }
    }
    case "reauthorize": {
      const report: CommandReport = { kind: "reauthorize", pledgeId: cmd.pledgeId, requestId: cmd.requestId, outcome: "done" };
      try {
        const a = await gw.reauthorize({ authorizationId: cmd.authorizationId, amount: cmd.amount, requestId: cmd.requestId });
        const event: LedgerEvent = { id: `${cmd.requestId}:done`, type: "Reauthorized", at: a.createTime ?? at, driveId: cmd.driveId, pledgeId: cmd.pledgeId, requestId: cmd.requestId, authorizationId: a.id };
        return { events: [{ event, source: "paypal_response" }], report: { ...report, ids: { authorizationId: a.id, status: a.status } } };
      } catch (e) {
        if (e instanceof PayPalError) return { events: [], report: { ...report, outcome: isRefusal(e) ? "refused" : "pending", detail: describe(e) } };
        throw e;
      }
    }
  }
}
