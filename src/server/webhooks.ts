import { parsePayPalMoney } from "../paypal/money";
import { parseCapture } from "../paypal/parse";
import type { CaptureResult } from "../paypal/types";
import type { Money } from "../core/types";

// What a verified PayPal webhook event refers to. Pure: resolving it to a
// drive and a ledger event needs the database and happens in the service.

export type WebhookTarget =
  /** COMPLETED, or DENIED/DECLINED with `detail` (PayPal's status and reason) for the core's classifier. */
  | { kind: "capture"; capture: CaptureResult; invoiceId: string | null; detail: string | null; at: string }
  /** REVERSED / REFUNDED: money taken back after a confirmed capture. */
  | { kind: "reversal"; captureId: string; amount: Money; reversalId: string | null; reason: string; at: string }
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

const CAPTURE_TYPES = new Set(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]);
const REVERSAL_TYPES = new Set(["PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.REFUNDED"]);

const CAPTURE_HREF = /\/v2\/payments\/captures\/([A-Z0-9]+)(?:$|[/?])/;

/**
 * The capture a REVERSED/REFUNDED resource belongs to. Refund-shaped resources (a refund id, the capture
 * in related ids or in the "up" link) and capture-shaped ones (the capture itself) both occur.
 */
function reversalOf(r: Json): { captureId: string; reversalId: string | null } | null {
  const id = str(r.id);
  const related = str(obj(obj(r.supplementary_data).related_ids).capture_id);
  const links = (Array.isArray(r.links) ? r.links : []).map(obj);
  const up = links.map((l) => (l.rel === "up" ? CAPTURE_HREF.exec(String(l.href ?? ""))?.[1] : undefined)).find(Boolean);
  const captureId = related ?? up ?? null;
  if (captureId && captureId !== id) return { captureId, reversalId: id };
  const self = links.map((l) => (l.rel === "self" ? CAPTURE_HREF.exec(String(l.href ?? ""))?.[1] : undefined)).find(Boolean);
  if (id && (self === id || !links.length)) return { captureId: id, reversalId: null };
  return null;
}
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
      if (type === "PAYMENT.CAPTURE.COMPLETED") return { kind: "capture", capture: parsed, invoiceId: str(r.invoice_id), detail: null, at };
      // The event type decides; PayPal's own status and reason go along so the core can tell terminal from retryable.
      const detail = [type, `status=${parsed.status}`, str(obj(r.status_details).reason)].filter(Boolean).join(" ");
      return { kind: "capture", capture: { ...parsed, status: "DECLINED" }, invoiceId: str(r.invoice_id), detail, at };
    }
    if (REVERSAL_TYPES.has(type)) {
      const of = reversalOf(r);
      if (!of) return { kind: "ignore", note: `${type}: no capture id in the resource` };
      const reason = [type, str(r.status) && `status=${str(r.status)}`, str(obj(r.status_details).reason), str(r.note_to_payer)].filter(Boolean).join(" ");
      return { kind: "reversal", ...of, amount: parsePayPalMoney(r.amount), reason, at };
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
