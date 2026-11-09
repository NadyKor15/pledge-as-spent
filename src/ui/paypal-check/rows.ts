import type { CheckRow, ExpiryVerdict } from "@/server/paypal-check";
import type { Lang } from "../format";
import { CHECK_WORDS } from "./words";

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

/** PayPal's statuses of a hold that can still be captured: its end date is still ahead of it. */
const LIVE = new Set(["CREATED", "PARTIALLY_CAPTURED", "PENDING"]);

/**
 * A hold's end date in the check's table: the day PayPal ends it by itself (expiration_time), and whether the book
 * has the same day. Null for captures, payouts and holds PayPal gave no date for.
 */
export function endLine(r: CheckRow, lang: Lang): { says: string; date: string; book: string | null; verdict: ExpiryVerdict | null } | null {
  if (r.kind !== "authorization" || !r.paypal.expires) return null;
  const w = CHECK_WORDS[lang];
  const date = utc(r.paypal.expires);
  const says = r.paypal.status && LIVE.has(r.paypal.status) ? w.endsBy(date) : w.endDate(date);
  const book = r.book.expires ? (r.expiry === "agrees" ? w.bookSame : w.bookOther(utc(r.book.expires))) : null;
  return { says, date, book, verdict: r.book.expires ? r.expiry : null };
}
