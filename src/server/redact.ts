import { isClosedCopy, openPlan, type Band, type PurchaseLine } from "../receipts/close";

// The only copy of a receipt photo that is ever published is the closed one: its purchase lines as printed, the rest
// a smooth background (src/receipts/close.ts). The reading makes it from its bands and purchase lines (`closed`);
// nothing here blurs, and nothing falls back to the original or to a blurred copy: a reading without a closed copy
// publishes no photo at all.

export interface Redaction {
  /** The closed copy; null when there is none, and then nothing is published. */
  bytes: Uint8Array | null;
  /** Purchase lines left open on the closed copy. */
  openLines: number;
  /** True only for a copy made by closing: it carries the closing mark. */
  closed: boolean;
  note: string | null;
}

export const NOT_CLOSED_NOTE = "Only the purchase lines of a receipt are ever shown, and they could not be placed on this photo, so it is not published.";
/** A copy stored before receipts were closed to their purchase lines: it is never served again. */
export const LEGACY_NOTE = "This photo was published before receipts were closed to their purchase lines, so it is no longer shown.";

/**
 * The copy a reading may publish: its `closed` copy (src/receipts/close.ts, made from the reading's `bands` and
 * `purchaseLines`), only when it carries the closing mark and opens at least one purchase line. Anything else, an
 * older reading without rows among them, publishes nothing.
 */
export function publishedCopy(reading: object): Redaction {
  const r = reading as { closed?: unknown; bands?: unknown; purchaseLines?: unknown };
  const bytes = r.closed instanceof Uint8Array && isClosedCopy(r.closed) ? r.closed : null;
  const openLines =
    bytes && Array.isArray(r.bands) && Array.isArray(r.purchaseLines) ? openPlan(r.bands as Band[], r.purchaseLines as PurchaseLine[]).lines.filter((l) => l.open).length : 0;
  if (!bytes || openLines === 0) return { bytes: null, openLines: 0, closed: false, note: NOT_CLOSED_NOTE };
  return { bytes, openLines, closed: true, note: null };
}

/** What a receipt's stored check says about its published copy: closed, or why there is none to show. */
export function publication(stored: boolean, redaction: { closed?: unknown; note?: unknown } | undefined): { published: boolean; note: string } {
  if (stored && redaction?.closed === true) return { published: true, note: "" };
  if (stored) return { published: false, note: LEGACY_NOTE };
  return { published: false, note: typeof redaction?.note === "string" && redaction.note ? redaction.note : "Not published." };
}
