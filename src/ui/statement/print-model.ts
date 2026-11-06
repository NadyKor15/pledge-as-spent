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
  captureId: string | null;
  requestId: string | null;
  note: string | null;
}

export interface PrintModel {
  driveTitle: string;
  donor: string;
  pledgeId: string;
  holdId: string | null;
  holdExpires: string | null;
  currency: string;
  baseCurrency: string;
  rows: PrintRow[];
  totals: { label: string; value: string; strong: boolean }[];
}

/** What the printed statement shows, as strings: one place decides the words and the money formats. */
export function printModel(view: StatementView): PrintModel {
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
      requestId: r.requestId,
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
    driveTitle: drive.title,
    donor: st.donorName,
    pledgeId: st.pledgeId,
    holdId: b.authorizationId,
    holdExpires: b.expiresAt ? day(b.expiresAt) : null,
    currency: cur,
    baseCurrency: base,
    rows,
    totals,
  };
}
