"use client";

import type { CheckResult } from "@/server/paypal-check";
import type { DriveView, Statement } from "../types";
import { AskPayPal } from "./AskPayPal";

/** The donor's statement: "don't take our word for it", and the button that asks PayPal about this donor's hold. */
export function StatementCheck({ view, st, onResult }: { view: DriveView; st: Statement; onResult?: (result: CheckResult) => void }) {
  const receiptIds = [...new Set(st.rows.map((r) => r.receiptId))];
  return (
    <section className="st-card pc-st" aria-labelledby="pc-st-title">
      <h2 className="st-h2" id="pc-st-title">
        Don’t take our word for it
      </h2>
      <p className="pc-st-text">PayPal’s sandbox answers for your hold, its captures and the volunteer’s payout. Our server only reads: GET requests, with its own keys.</p>
      <AskPayPal driveId={view.drive.id} focus={{ pledgeId: st.balance.pledgeId, receiptIds }} className="st-btn pc-st-btn" testId="statement-ask-paypal" onResult={onResult} />
    </section>
  );
}
