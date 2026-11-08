import { moneyIn, whenUtc, type Lang } from "../format";
import type { DriveView } from "../types";
import type { LedgerModel } from "./derive";
import { WORDS } from "./i18n";

// The proof of one row of the book: the printed line cut out of the receipt's published photo, how the line's
// amount was split between the donor and the match, and PayPal's capture with its own status and time.
// Everything is read from the drive view: nothing here is computed that the book does not already say.

export type Box = { x: number; y: number; w: number; h: number };

export interface LineProof {
  rowKey: string;
  lineKey: string;
  line: number;
  /** The line's name as the book shows it. */
  item: string;
  /** The line as the receipt prints it. */
  printed: string;
  /** The published (blurred) photo and where the line is on it; null without a box or a published photo. */
  strip: { url: string; box: Box } | null;
  /** "ミナト生活館 北空店 · receipt ¥14,646". */
  receipt: string;
  /** "Line 4 · Soft kids diapers M · ¥2,596 = Mark · Columbus $8.58 (¥1,298) + Kitasora Logistics match ¥1,298". */
  sentence: string;
  /** PayPal's capture of this row: its id, PayPal's word for it and when PayPal said so. */
  capture: { id: string | null; state: string; at: string | null };
  /** The match's capture of the same line, beside a donor's. */
  matchCapture: string | null;
  reason: string | null;
}

/** "Nov 1, 02:06 UTC" (src/ui/format.ts): the volunteer's payout is dated the same way. */
export { whenUtc };

export function lineProof(v: DriveView, m: LedgerModel, rowKey: string, lang: Lang = m.lang ?? "en"): LineProof | null {
  const w = WORDS[lang];
  const row = m.book.find((r) => r.rowKey === rowKey);
  const own = v.ledger.find((r) => r.rowId === rowKey);
  if (!row || !own) return null;
  const receipt = v.receipts.find((r) => r.id === own.receiptId);
  const line = receipt?.lines.find((l) => l.lineNo === own.lineNo);
  const base = v.drive.baseCurrency;
  const image = receipt?.image;
  const url = image?.published && "url" in image ? image.url : undefined;
  const strip = url && line?.box ? { url, box: line.box } : null;

  const shares = m.book.filter((r) => r.lineKey === row.lineKey && (r.kind === "donor_share" || r.kind === "match_share"));
  const currencyOf = (key: string) => v.ledger.find((r) => r.rowId === key)?.currency ?? base;
  const part = (s: (typeof shares)[number]) =>
    s.kind === "match_share" ? `${s.payer} ${w.matchWord} ${moneyIn(lang, base, s.share)}` : `${s.payerLabel} ${s.paid}${currencyOf(s.rowKey) === base ? "" : ` (${moneyIn(lang, base, s.share)})`}`;
  const amount = line ? moneyIn(lang, receipt?.currency ?? base, line.amount) : moneyIn(lang, base, row.share);
  const head = `${w.lineWord} ${row.line} · ${row.item} · ${amount}`;
  const sentence = shares.length ? `${head} = ${shares.map(part).join(" + ")}` : `${head}${row.reason ? ` — ${row.reason}` : ""}`;

  // PayPal's own answer to the capture call, from the drive's journal; the book's word when the journal has none.
  const call = own.captureId ? v.paypal.find((c) => (c.ids as { id?: string } | null)?.id === own.captureId) : undefined;
  const paypalStatus = (call?.ids as { status?: string } | null)?.status;
  const back = own.status === "reversed" || own.status === "partly_reversed";
  const state = !own.captureId
    ? own.status === "accrued" || own.status === "capture_pending"
      ? w.captureState.pending
      : w.captureState.none
    : back
      ? w.captureState.back
      : paypalStatus === "COMPLETED" || (!paypalStatus && own.status === "captured")
        ? w.captureState.done
        : w.captureState.pending;
  const at = own.captureId ? (call?.ts ?? own.at ?? null) : null;
  const match = own.kind === "donor_share" ? shares.find((s) => s.kind === "match_share" && s.capture !== "—") : undefined;

  return {
    rowKey,
    lineKey: row.lineKey,
    line: row.line,
    item: row.item,
    printed: line?.text ?? "",
    strip,
    receipt: receipt ? w.receiptOf(receipt.merchant ?? "", moneyIn(lang, receipt.currency ?? base, receipt.total)) : "",
    sentence,
    capture: { id: own.captureId ?? null, state, at: at ? whenUtc(lang, at) : null },
    matchCapture: match?.capture ?? null,
    reason: row.reason,
  };
}

/**
 * The CSS that shows exactly `box` of a photo `size` px large, as large as fits in maxW × maxH and never stretched:
 * the photo becomes the strip's background, scaled and moved so the box fills the strip.
 */
export function stripStyle(box: Box, size: { width: number; height: number }, maxW: number, maxH: number) {
  const bw = box.w * size.width;
  const bh = box.h * size.height;
  const s = Math.min(maxW / bw, maxH / bh);
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  return {
    width: Math.round(bw * s * 100) / 100,
    height: Math.round(bh * s * 100) / 100,
    backgroundSize: `${px(size.width * s)} ${px(size.height * s)}`,
    backgroundPosition: `${px(-box.x * size.width * s)} ${px(-box.y * size.height * s)}`,
  };
}
