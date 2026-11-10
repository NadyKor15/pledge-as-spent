import { and, eq } from "drizzle-orm";
import type { CaptureConfirmed } from "../core/events";
import type { Db } from "../db/client";
import { events } from "../db/schema";

// What PayPal itself reported as its fee on a donor's captures: the paypal_fee of each capture's
// seller_receivable_breakdown, as the book recorded it on CaptureConfirmed. Read only. Nothing here estimates a fee
// (src/core/fees.ts holds the published rates for the savings figure): a capture PayPal reported no fee for is counted
// as not reported, never filled in.

export interface ReportedFee {
  /** The hold's currency. */
  currency: string;
  /** Sum of the fees PayPal reported, over the captures that reported one. */
  minor: number;
  /** Captures PayPal confirmed on this hold. */
  captures: number;
  /** Of those, the ones whose answer carried a paypal_fee in the hold's currency. */
  reported: number;
}

/** Each hold's reported fee on one drive, from its CaptureConfirmed events (holds with no capture: zero captures). */
export async function reportedFees(db: Db, driveId: string, holds: { pledgeId: string; currency: string }[]): Promise<Record<string, ReportedFee>> {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.driveId, driveId), eq(events.type, "CaptureConfirmed")));
  const out: Record<string, ReportedFee> = Object.fromEntries(holds.map((h) => [h.pledgeId, { currency: h.currency, minor: 0, captures: 0, reported: 0 }]));
  for (const r of rows) {
    const e = r.payload as CaptureConfirmed;
    const f = out[e.pledgeId];
    if (!f) continue;
    f.captures += 1;
    if (e.paypalFee && e.paypalFee.currency === f.currency && Number.isInteger(e.paypalFee.minor) && e.paypalFee.minor >= 0) {
      f.minor += e.paypalFee.minor;
      f.reported += 1;
    }
  }
  return out;
}

/** One hold's: the same reading. */
export async function reportedFee(db: Db, driveId: string, pledgeId: string, currency: string): Promise<ReportedFee> {
  return (await reportedFees(db, driveId, [{ pledgeId, currency }]))[pledgeId];
}