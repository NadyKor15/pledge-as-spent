import type { CheckRow } from "@/server/paypal-check";

/** "2026-11-01T02:06:20Z" -> "2026-11-01 02:06:20 UTC"; PayPal's local offsets ("08:49:46-07:00") are turned into UTC. */
export function utc(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The rows a donor's statement shows first: their own hold and captures, and the payouts their money went to. */
export function rowsFor(rows: CheckRow[], focus?: { pledgeId: string; receiptIds: string[] }): CheckRow[] {
  if (!focus) return rows;
  return rows.filter((r) => (r.kind === "payout" ? r.receiptId !== null && focus.receiptIds.includes(r.receiptId) : r.pledgeId === focus.pledgeId));
}
