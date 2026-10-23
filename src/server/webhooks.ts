import { parsePayPalMoney } from "../paypal/money";
import { parseCapture } from "../paypal/parse";
import type { CaptureResult } from "../paypal/types";
import type { Money } from "../core/types";

// What a verified PayPal webhook event refers to. Pure: resolving it to a
// drive and a ledger event needs the database and happens in the service.

export type WebhookTarget =
  | { kind: "capture"; capture: CaptureResult; invoiceId: string | null; at: string }
  | { kind: "void"; authorizationId: string; at: string }
  | {
      kind: "payout";
      status: "SUCCESS" | "FAILED";
      senderBatchId: string | null;
      senderItemId: string | null;
      payoutBatchId: string | null;
      fee: Money | null;
      reason: string;
      at: string;
    }
  | { kind: "ignore"; note: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const CAPTURE_TYPES = new Set(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.REVERSED"]);
const PAYOUT_FAILED_TYPES = new Set([
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
]);

export function webhookTarget(event: unknown): WebhookTarget {
  const e = obj(event);
  const type = str(e.event_type) ?? "";
  const r = obj(e.resource);
  const at = str(r.update_time) ?? str(r.create_time) ?? str(e.create_time) ?? new Date().toISOString();
  try {
    if (CAPTURE_TYPES.has(type)) {
      const parsed = parseCapture(r);
      // DENIED/DECLINED/REVERSED events can carry a status that still reads COMPLETED; the event type decides.
      const capture = type === "PAYMENT.CAPTURE.COMPLETED" ? parsed : { ...parsed, status: type === "PAYMENT.CAPTURE.REVERSED" ? "FAILED" : "DECLINED" };
      return { kind: "capture", capture, invoiceId: str(r.invoice_id), at };
    }
    if (type === "PAYMENT.AUTHORIZATION.VOIDED") {
      const id = str(r.id);
      return id ? { kind: "void", authorizationId: id, at } : { kind: "ignore", note: "VOIDED event without an authorization id" };
    }
    if (type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" || PAYOUT_FAILED_TYPES.has(type)) {
      const item = obj(r.payout_item);
      const fee = r.payout_item_fee ? parsePayPalMoney(r.payout_item_fee) : null;
      return {
        kind: "payout",
        status: type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" ? "SUCCESS" : "FAILED",
        senderBatchId: str(r.sender_batch_id) ?? str(obj(r.sender_batch_header).sender_batch_id),
        senderItemId: str(item.sender_item_id),
        payoutBatchId: str(r.payout_batch_id),
        fee,
        reason: `${type} ${str(r.transaction_status) ?? ""}`.trim(),
        at: str(r.time_processed) ?? at,
      };
    }
  } catch (err) {
    return { kind: "ignore", note: `${type}: resource not understood (${(err as Error).message})` };
  }
  return { kind: "ignore", note: `event type ${type || "(none)"} is not used by this app` };
}
