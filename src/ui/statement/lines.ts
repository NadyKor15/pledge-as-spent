import type { Box } from "../ledger/proof";
import type { DriveView, Statement } from "../types";

// "My euro in the receipt": each line of the receipt a donor's money paid for, with the donor's share of it, where the line
// is printed on the published photo (for a strip cut from it) and what it says in words. Everything is a lookup of the
// statement and the drive view; a line the reader did not place on the photo has no box and gets no strip.

export interface StatementLine {
  receiptId: string;
  lineNo: number;
  /** The donor's share of this line, in the donor's currency (one statement row; several when two needs share a line). */
  share: number;
  currency: string;
  /** The published photo and the line's box on it; null when the photo is not published or the line is not placed. */
  photo: { url: string; box: Box } | null;
  /** The words printed on the receipt, as read. */
  printed: string;
  /** The line in English, from the reading; the printed words when the reader gave none. */
  english: string;
}

const LANG_NAME: Record<string, string> = { de: "German", ja: "Japanese" };

/** The line under the items when some lines could not be had in the donor's language (they stay in English). */
export function translationNote(t: { lang: string; unavailable: boolean } | null): string | null {
  if (!t || t.lang === "en" || !t.unavailable) return null;
  return `Some lines are shown in English: a translation into ${LANG_NAME[t.lang] ?? t.lang} is not available right now.`;
}

export function statementLines(view: DriveView, st: Statement, receiptId: string, lineNos: number[]): StatementLine[] {
  const receipt = view.receipts.find((r) => r.id === receiptId);
  const url = receipt?.image.published ? (receipt.image.url ?? null) : null;
  return [...new Set(lineNos)]
    .sort((a, b) => a - b)
    .map((lineNo) => {
      const line = receipt?.lines.find((l) => l.lineNo === lineNo);
      const share = st.rows.filter((r) => r.receiptId === receiptId && r.lineNo === lineNo).reduce((sum, r) => sum + r.share.minor, 0);
      const printed = (line?.text ?? "").trim();
      return {
        receiptId,
        lineNo,
        share,
        currency: st.currency,
        photo: url && line?.box ? { url, box: line.box } : null,
        printed,
        english: (line?.translationEn ?? "").trim() || printed,
      };
    });
}
