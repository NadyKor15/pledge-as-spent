import { day, money } from "../format";
import type { StatementView } from "../types";
import { STATUS_WORDS } from "./words";

export interface PrintRow {
  key: string;
  line: string;
  item: string;
  qty: string;
  status: string;
  share: string;
  match: string;
  /** PayPal's own capture id, which the donor can look up. Our request ids are bookkeeping and stay off the page. */
  captureId: string | null;
  note: string | null;
}

export interface PrintModel {
  driveTitle: string;
  donor: string;
  pledgeId: string;
  holdId: string | null;
  /** Under the hold's id: "expires 30 Nov 2026" while it lives, "released" once voided, and so on. */
  holdNote: string | null;
  currency: string;
  baseCurrency: string;
  rows: PrintRow[];
  totals: { label: string; value: string; strong: boolean }[];
}

/** A hold that is over has no expiry to show: what happened to it instead. */
const HOLD_OVER: Partial<Record<string, string>> = { voided: "released", expired: "expired", captured: "captured in full", denied: "declined by PayPal" };

function holdNote(status: string, expiresAt: string | null | undefined): string | null {
  return HOLD_OVER[status] ?? (expiresAt ? `expires ${day(expiresAt)}` : null);
}

/** What the printed statement shows, as strings: one place decides the words and the money formats. */
export function printModel(view: StatementView, opts: { driveTitle?: string } = {}): PrintModel {
  const { statement: st, drive } = view;
  const cur = st.currency;
  const base = st.baseCurrency;
  const b = st.balance;
  const rows: PrintRow[] = st.rows.map((r) => {
    const note = r.reversed ? `${money(cur, r.reversed)} taken back by PayPal` : r.uncollectedReason;
    return {
      key: `${r.receiptId}:${r.lineNo}`,
      line: `${r.receiptId.startsWith(`${drive.id}.`) ? r.receiptId.slice(drive.id.length + 1) : r.receiptId} · ${r.lineNo}`,
      item: r.item,
      qty: `${r.qty} × ${r.unit}`,
      status: STATUS_WORDS[r.status] ?? r.status,
      share: money(cur, r.share.minor),
      match: money(base, r.matchBase),
      captureId: r.captureId,
      note,
    };
  });
  const totals: PrintModel["totals"] = [
    { label: "Pledged", value: money(cur, b.pledged), strong: true },
    { label: "Charged", value: money(cur, st.totals.charged), strong: true },
    { label: "Released at PayPal", value: money(cur, b.released), strong: false },
  ];
  if (st.totals.reversed > 0) totals.push({ label: "Taken back by PayPal after capture", value: money(cur, st.totals.reversed), strong: false });
  if (st.totals.uncollected > 0) totals.push({ label: "Not collected", value: money(cur, st.totals.uncollected), strong: false });
  totals.push({ label: "Your shares, total", value: money(cur, st.totals.share), strong: false });
  if (st.totals.matchBase > 0) totals.push({ label: "Match unlocked", value: money(base, st.totals.matchBase), strong: false });
  totals.push({ label: "Help bought, total", value: money(base, st.totals.helpBase), strong: true });
  return {
    driveTitle: opts.driveTitle ?? drive.title,
    donor: st.donorName,
    pledgeId: st.pledgeId,
    holdId: b.authorizationId,
    holdNote: holdNote(b.status, b.expiresAt),
    currency: cur,
    baseCurrency: base,
    rows,
    totals,
  };
}
