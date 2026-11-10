import type { CheckResult } from "@/server/paypal-check";
import { returningAtPayPal } from "../derive";
import { day } from "../format";
import { utc } from "../paypal-check/rows";
import type { JournalCall, Statement } from "../types";

// "What if we vanish?" on a donor's statement. A pledge is a PayPal hold, and PayPal ends a hold by itself on a day it
// sets (expiration_time, 29 days from the first approval). The book keeps the same day; once the donor asks PayPal
// (Ask PayPal yourself), PayPal's own word on it is set beside it. Nothing here promises a capture or calls the
// money safe: it says when PayPal ends the hold, and that nothing more can be charged after that.

export type VanishHold = Pick<Statement["balance"], "pledgeId" | "status" | "revoked" | "expiresAt" | "authorizationId">;

/** PayPal's statuses of a hold that can still be captured: only then is its end date still ahead of it. */
const LIVE_AT_PAYPAL = new Set(["CREATED", "PARTIALLY_CAPTURED", "PENDING"]);
/** PayPal's statuses of a hold that is over. */
const OVER_AT_PAYPAL = new Set(["VOIDED", "EXPIRED", "CAPTURED", "DENIED"]);

/** The day PayPal answered this hold's void with a success, from the journal of PayPal calls; null if it never did. */
function voidedAt(h: VanishHold, calls: readonly JournalCall[]): string | null {
  const ok = calls.filter((c) => c.method === "POST" && /\/void$/.test(c.path) && c.requestId?.endsWith(`:${h.pledgeId}`) && c.httpStatus >= 200 && c.httpStatus < 300);
  return ok.length ? ok[ok.length - 1].ts : null;
}

export function vanishLine(h: VanishHold, calls: readonly JournalCall[], check: CheckResult | null): { text: string; confirm: string | null } | null {
  const row = check?.rows.find((r) => r.kind === "authorization" && r.id === h.authorizationId && r.paypal.http === 200) ?? null;
  if (h.status === "voided") {
    const at = voidedAt(h, calls);
    return {
      text: at ? `PayPal voided this hold on ${day(at)}: nothing more can be charged from it.` : "PayPal voided this hold: nothing more can be charged from it.",
      confirm: row?.paypal.status === "VOIDED" ? `PayPal confirms: VOIDED, ${utc(row.paypal.updated)}.` : null,
    };
  }
  if (!h.expiresAt) return null;
  if (h.status === "expired") return { text: `PayPal ended this hold on ${day(h.expiresAt)}: nothing more can be charged from it.`, confirm: null };
  if ((h.status !== "authorized" && h.status !== "partially_captured") || returningAtPayPal(h)) return null;
  const status = row?.paypal.status ?? null;
  // PayPal is ahead of the book (a void or capture already went through): its word, not a confirmation of the date.
  const confirm =
    status && !LIVE_AT_PAYPAL.has(status)
      ? `PayPal now reports this hold ${status}${OVER_AT_PAYPAL.has(status) ? ": nothing more can be charged from it" : ""}.`
      : !row?.paypal.expires
        ? null
        : row.expiry === "agrees"
          ? "PayPal confirms this date."
          : `PayPal’s own date for it: ${utc(row.paypal.expires)}.`;
  return { text: `If Pledge-as-Spent disappears today, PayPal ends this hold by ${day(h.expiresAt)}, and nothing more can be charged after that.`, confirm };
}

/**
 * The line after a withdrawal. The rest is never charged once PayPal released the hold; a share that was charged and
 * then refunded was charged, so a hold with a refund keeps "went back".
 */
export function withdrawnNote(h: Pick<Statement["balance"], "revoked" | "status" | "reversed">): string {
  if (returningAtPayPal(h)) return "You withdrew this pledge. What was already bought stays paid; the rest is on its way back at PayPal.";
  return h.reversed > 0
    ? "You withdrew this pledge. What was already bought stays paid; the rest went back at PayPal."
    : "You withdrew this pledge. What was already bought stays paid; the rest was never charged: PayPal released the hold.";
}
