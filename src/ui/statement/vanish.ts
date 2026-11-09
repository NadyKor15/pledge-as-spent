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
  const confirm = !row?.paypal.expires ? null : row.expiry === "agrees" ? "PayPal confirms this date." : `PayPal’s own date for it: ${utc(row.paypal.expires)}.`;
  return { text: `If Pledge-as-Spent disappears today, PayPal ends this hold by ${day(h.expiresAt)}, and nothing more can be charged after that.`, confirm };
}
