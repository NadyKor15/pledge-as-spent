"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { money } from "./format";
import type { ReportedFee } from "@/server/reported-fee";

// "Pledge-as-Spent fee: 0 % · PayPal's fee on capturing your share: €0.51, paid by the drive, not by you": the app
// takes nothing; what PayPal took is what PayPal itself reported on the donor's captures, and the drive pays it (as the
// book's footer says: "PayPal's fees are paid from the drive's balance, not from pledges"). A capture PayPal reported
// no fee for is said so, never estimated.

const PAYPAL = "PayPal’s fee on capturing your share";
const NOT_YOU = "paid by the drive, not by you";

export function feeLine(f: ReportedFee | null | undefined): string | null {
  if (!f) return null;
  const ours = "Pledge-as-Spent fee: 0 %";
  if (f.captures === 0) return `${ours} · ${PAYPAL}: none, nothing captured yet`;
  if (f.reported === 0) return `${ours} · ${PAYPAL}: not reported by PayPal`;
  const amount = money(f.currency, f.minor);
  if (f.reported < f.captures) return `${ours} · ${PAYPAL}: ${amount} (reported by PayPal for ${f.reported} of ${f.captures} captures), ${NOT_YOU}`;
  return `${ours} · ${PAYPAL}: ${amount}, ${NOT_YOU}`;
}

/** One donor's fee over their renewal chain's holds (one hold without a renewal: its own entry, unchanged). */
export function chainFee(fees: Record<string, ReportedFee> | null | undefined, ids: readonly string[]): ReportedFee | undefined {
  const own = ids.map((id) => fees?.[id]).filter((f): f is ReportedFee => !!f);
  if (own.length <= 1) return own[0];
  return own.reduce((a, f) => ({ currency: a.currency, minor: a.minor + f.minor, captures: a.captures + f.captures, reported: a.reported + f.reported }));
}

/** The drive's reported fees, by pledge; null until read, or if they cannot be (the line is then left out). */
export function useReportedFees(driveId: string, version: string): Record<string, ReportedFee> | null {
  const [fees, setFees] = useState<Record<string, ReportedFee> | null>(null);
  useEffect(() => {
    let live = true;
    api<{ fees: Record<string, ReportedFee> }>(`/api/drives/${encodeURIComponent(driveId)}/fees`).then(
      (r) => live && setFees(r.fees),
      () => live && setFees(null),
    );
    return () => {
      live = false;
    };
  }, [driveId, version]);
  return fees;
}
