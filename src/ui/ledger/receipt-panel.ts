import { lineGross } from "../derive";
import { moneyIn, type Lang } from "../format";
import type { DriveView } from "../types";
import type { LedgerModel } from "./derive";
import { WORDS } from "./i18n";
import { lineProof, type Box } from "./proof";
import { PANEL_WORDS } from "./words-panels";

// The receipt beside the book (T4): the published photo of the receipt the footer links to, a button over every
// line of it that the book has, and the lines the reader could not place on the photo listed under it.
// Everything is read from the drive view and the book: the boxes are the reader's (views.ts), the amounts printed.

export interface ReceiptMark {
  /** `<receiptId>:<lineNo>`, the book's own key for every share of the line. */
  lineKey: string;
  lineNo: number;
  /** Where the line is on the published photo, fractions 0..1; null when the reader did not place it. */
  box: Box | null;
  /** The printed line, for the list of lines that are not on the photo. */
  text: string;
  /** "Line 4 · ¥2,596", for a screen reader. */
  label: string;
  /** "¥2,596": the printed line with its share of tax. */
  amount: string;
  /** Every row of the book for this line is a refusal: nobody pays it. */
  refused: boolean;
}

export interface ReceiptPanel {
  url: string;
  head: string;
  /** Lines with a box, in print order. */
  placed: ReceiptMark[];
  /** Lines without one, in print order. */
  unplaced: ReceiptMark[];
  /** The part of the photo the placed lines are on, with a margin: a narrow screen shows only that. */
  region: Box;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** The placed lines' bounding box, padded, inside the photo; the whole photo when nothing is placed. */
export function linesRegion(boxes: readonly Box[], padX = 0.04, padY = 0.03): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = clamp(Math.min(...boxes.map((b) => b.x)) - padX);
  const y0 = clamp(Math.min(...boxes.map((b) => b.y)) - padY);
  const x1 = clamp(Math.max(...boxes.map((b) => b.x + b.w)) + padX);
  const y1 = clamp(Math.max(...boxes.map((b) => b.y + b.h)) + padY);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const pct = (n: number) => `${Math.round(n * 1e5) / 1e3}%`;

/** Where a line's button sits over the shown part of the photo, in percent of it (the photo's own box, 0..1). */
export function markStyle(box: Box, region: Box) {
  return { left: pct((box.x - region.x) / region.w), top: pct((box.y - region.y) / region.h), width: pct(box.w / region.w), height: pct(box.h / region.h) };
}

/** The photo inside the shown part: as wide as the part is narrow, moved so the part's corner is at the frame's. */
export function photoStyle(region: Box) {
  return { width: pct(1 / region.w), left: pct(-region.x / region.w), top: pct(-region.y / region.h) };
}

/** The receipt whose photo the bottom line links to (model.receiptUrl), with the book's lines on it; null without one. */
export function receiptPanel(v: DriveView | null, m: LedgerModel, lang: Lang = m.lang ?? "en"): ReceiptPanel | null {
  if (!v || !m.receiptUrl) return null;
  const receipt = v.receipts.find((r) => r.image.published && "url" in r.image && r.image.url === m.receiptUrl);
  if (!receipt) return null;
  const w = PANEL_WORDS[lang];
  const currency = receipt.currency ?? v.drive.baseCurrency;
  const marks = receipt.lines.flatMap((l): ReceiptMark[] => {
    const lineKey = `${receipt.id}:${l.lineNo}`;
    const rows = m.book.filter((r) => r.lineKey === lineKey);
    if (!rows.length) return [];
    const amount = moneyIn(lang, currency, lineGross(l));
    const refused = rows.every((r) => r.kind === "rejected");
    return [{ lineKey, lineNo: l.lineNo, box: l.box ?? null, text: l.text, label: refused ? w.refusedLine(l.lineNo, amount) : w.pressLine(l.lineNo, amount), amount, refused }];
  });
  const placed = marks.filter((x) => x.box);
  return {
    url: m.receiptUrl,
    // The total never breaks between its figure and its sign ("14.646 ¥" in German).
    head: w.receiptHead(receipt.merchant ?? "", receipt.total === null ? "" : moneyIn(lang, currency, receipt.total).replace(/\s/g, " ")),
    placed,
    unplaced: marks.filter((x) => !x.box),
    region: linesRegion(placed.map((x) => x.box!)),
  };
}

export interface LinePayer {
  /** "Mark · Columbus", "Kitasora Logistics": the chip. */
  label: string;
  /** "$8.58 (¥1,298)", "match ¥1,298": what follows it. */
  amount: string;
  /** The donor's pledge; null for the company match. */
  pledgeId: string | null;
}

/**
 * The plaque over the book for a pressed line (S5), in parts: "Line 4 · ¥2,596 =", then each payer as a chip and
 * what they paid, as the proof band says it (proof.ts lineProof), or the reason a refused line has no payer.
 */
export function lineParts(v: DriveView | null, m: LedgerModel, lineKey: string, lang: Lang = m.lang ?? "en"): { head: string; payers: LinePayer[]; reason: string | null } | null {
  if (!v) return null;
  const rows = m.book.filter((r) => r.lineKey === lineKey);
  if (!rows.length) return null;
  const base = v.drive.baseCurrency;
  const mark = receiptPanel(v, m, lang);
  const printed = [...(mark?.placed ?? []), ...(mark?.unplaced ?? [])].find((x) => x.lineKey === lineKey);
  const head = printed ? PANEL_WORDS[lang].pressLine(printed.lineNo, printed.amount) : `${WORDS[lang].lineWord} ${rows[0].line}`;
  const currencyOf = (rowKey: string) => v.ledger.find((r) => r.rowId === rowKey)?.currency ?? base;
  const payers = rows
    .filter((r) => r.kind === "donor_share" || r.kind === "match_share")
    .map((r): LinePayer =>
      r.kind === "match_share"
        ? { label: r.payer, amount: `${WORDS[lang].matchWord} ${moneyIn(lang, base, r.share)}`, pledgeId: null }
        : { label: r.payerLabel, amount: `${r.paid}${currencyOf(r.rowKey) === base ? "" : ` (${moneyIn(lang, base, r.share)})`}`, pledgeId: r.pledgeId },
    );
  const reason = payers.length ? null : (rows.find((r) => r.reason)?.reason?.replace(/\.$/, "") ?? null);
  return { head, payers, reason };
}

/** The one sentence over the book for a picked line: who paid what of it (the proof band's own words). */
export function lineSentence(v: DriveView | null, m: LedgerModel, lineKey: string, lang: Lang = m.lang ?? "en"): string | null {
  if (!v) return null;
  const rows = m.book.filter((r) => r.lineKey === lineKey);
  const row = rows.find((r) => r.kind === "donor_share") ?? rows[0];
  return row ? (lineProof(v, m, row.rowKey, lang)?.sentence ?? null) : null;
}
