import { toBase } from "@/core/money";
import { holdAmounts, latestFunded, lineName, needById } from "../derive";
import { donorParts, money, ofCount, pct, shortName, statusLabel, titleParts } from "../format";
import type { DriveView, Hold, Need } from "../types";
import { locate, type LonLat } from "./geo";

// The Ledger tab reads the drive view and nothing else: every figure below is a
// sum, a difference or a lookup of what the API returned.

export type LedgerPhase = "closed" | "open";

export interface LedgerDonor {
  pledgeId: string;
  name: string;
  city: string | null;
  /** "Mark · Columbus". */
  label: string;
  /** Null when the table of places does not know where the donor is: they keep their row, without an arc. */
  at: LonLat | null;
  currency: string;
  spent: number;
  /** Money that went back: released, not collected or reversed. */
  back: number;
  /** Money the hold still keeps. */
  held: number;
  spentText: string;
  /** What did not go to the shelter, with the word for it: back on a closed hold, held on an open one. */
  restText: string;
  restWord: "back" | "held";
  /** Weights for the arcs, in the drive's currency, so a euro and a yen compare. */
  spentBase: number;
  restBase: number;
  needIds: string[];
  lineKeys: string[];
}

export interface LedgerNeed {
  needId: string;
  label: string;
  /** "12 of 40 bottles". */
  count: string;
  percent: number;
  pledgeIds: string[];
  lineKeys: string[];
}

export interface LedgerRefusal {
  key: string;
  name: string;
  amount: string;
}

export interface LedgerBookRow {
  /** Sort position: by need in the drive's order, then by line. */
  order: number;
  lineKey: string;
  line: number;
  item: string;
  need: string;
  payer: string;
  share: number;
  charged: string;
  capture: string;
  status: string;
}

export interface LedgerModel {
  driveId: string;
  phase: LedgerPhase;
  shelter: string;
  baseCurrency: string;
  promised: number;
  spent: number;
  /** Promised minus spent: back with the donors on a closed drive, still on hold on an open one. */
  rest: number;
  restLabel: string;
  match: number;
  /** Null for a drive without a company match. */
  matchName: string | null;
  donors: LedgerDonor[];
  needs: LedgerNeed[];
  refused: LedgerRefusal[];
  receiptUrl: string | null;
  book: LedgerBookRow[];
}

const lineKey = (receiptId: string, lineNo: number) => `${receiptId}:${lineNo}`;

/** "Kitasora Community Shelter — Earthquake relief" -> "Kitasora Shelter", as the card calls it. */
export function shelterName(title: string): string {
  return titleParts(title).head.replace(/\bCommunity\s+/, "");
}

/** An amount of a pledge in the drive's currency, at the rate locked on that pledge. */
function inBase(h: Pick<Hold, "fx" | "currency">, minor: number, base: string): number {
  if (h.currency === base) return minor;
  return h.fx ? toBase(minor, h.fx) : 0;
}

function donorRow(v: DriveView, h: Hold, settled: boolean): LedgerDonor {
  const report = v.closeReport.find((r) => r.pledgeId === h.pledgeId);
  const a = holdAmounts(h);
  // A closed hold has its final figures in the close report. Before the close that report
  // counts only what PayPal captured, so an open hold is read from the hold itself.
  const spent = settled && report ? report.spent : a.spent;
  const back = settled && report ? report.released + report.uncollected + report.reversed : h.released + h.uncollected + h.reversed;
  const held = settled ? 0 : a.held;
  const restWord = held > 0 || !settled ? "held" : "back";
  const rest = restWord === "held" ? held : back;

  const city = donorParts(h.donorName).place;
  const name = shortName(h.donorName);
  const shares = v.ledger.filter((r) => r.kind === "donor_share" && r.pledgeId === h.pledgeId);
  const base = v.drive.baseCurrency;
  return {
    pledgeId: h.pledgeId,
    name,
    city,
    label: city ? `${name} · ${city}` : name,
    at: locate(city, h.donorCountry),
    currency: h.currency,
    spent,
    back,
    held,
    spentText: money(h.currency, spent),
    restText: money(h.currency, rest),
    restWord,
    spentBase: inBase(h, spent, base),
    restBase: inBase(h, rest, base),
    needIds: [...new Set(shares.flatMap((r) => (r.needId ? [r.needId] : [])))],
    lineKeys: [...new Set(shares.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

function needRow(v: DriveView, n: Need): LedgerNeed {
  const shares = v.ledger.filter((r) => r.kind === "donor_share" && r.needId === n.needId);
  return {
    needId: n.needId,
    label: n.displayLabel,
    count: ofCount(n.qtyCovered, n.qtyNeeded, n.unit),
    percent: Math.min(100, pct(n.qtyCovered, n.qtyNeeded)),
    pledgeIds: [...new Set(shares.flatMap((r) => (r.pledgeId ? [r.pledgeId] : [])))],
    lineKeys: [...new Set(shares.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

function bookRows(v: DriveView): LedgerBookRow[] {
  const needOrder = (id: string | null) => {
    const i = v.needs.findIndex((n) => n.needId === id);
    return i < 0 ? v.needs.length : i;
  };
  return v.ledger
    .filter((r) => r.kind === "donor_share" || r.kind === "match_share" || r.kind === "rejected" || r.kind === "unfunded")
    .map((r, i) => ({ r, i }))
    .sort((a, b) => needOrder(a.r.needId) - needOrder(b.r.needId) || a.r.lineNo - b.r.lineNo || a.i - b.i)
    .map(({ r }, order) => {
      const need = needById(v, r.needId);
      const line = v.receipts.find((x) => x.id === r.receiptId)?.lines.find((l) => l.lineNo === r.lineNo);
      const name = line ? lineName({ line, need }) : null;
      return {
        order,
        lineKey: lineKey(r.receiptId, r.lineNo),
        line: r.lineNo,
        item: name?.detail || name?.title || r.item || "",
        need: need?.displayLabel ?? "Refused",
        payer: r.donorName ? shortName(r.donorName) : "—",
        share: r.base,
        charged: r.amount === null ? "—" : money(r.currency, r.amount) || "—",
        capture: r.captureId ?? "—",
        status: statusLabel(r.status),
      };
    });
}

function refusals(v: DriveView): LedgerRefusal[] {
  return v.ledger.flatMap((r) => {
    if (r.kind !== "rejected") return [];
    const line = v.receipts.find((x) => x.id === r.receiptId)?.lines.find((l) => l.lineNo === r.lineNo);
    if (!line) return [];
    return [{ key: lineKey(r.receiptId, r.lineNo), name: lineName({ line, need: needById(v, r.needId) }).title, amount: money(v.drive.baseCurrency, r.base) }];
  });
}

/** The published photo donors can open: the newest funded receipt, else the newest published one. */
function receiptPhoto(v: DriveView): string | null {
  const funded = latestFunded(v);
  const r = funded?.image.published ? funded : [...v.receipts].reverse().find((x) => x.image.published);
  return r?.image.url ?? null;
}

/** Everything the Ledger tab shows. */
export function deriveLedger(v: DriveView): LedgerModel {
  const base = v.drive.baseCurrency;
  const holds = v.holds.filter((h) => h.kind === "donor" && h.authorized > 0);
  const closed = v.drive.status === "closed" && holds.every((h) => v.closeReport.find((r) => r.pledgeId === h.pledgeId)?.settled);
  const promised = holds.reduce((sum, h) => sum + inBase(h, h.authorized, base), 0);
  const spent = v.needs.reduce((sum, n) => sum + n.donorBase, 0);
  return {
    driveId: v.drive.id,
    phase: closed ? "closed" : "open",
    shelter: shelterName(v.drive.displayTitle),
    baseCurrency: base,
    promised,
    spent,
    rest: promised - spent,
    restLabel: closed ? "Returned to donors" : "Held",
    match: v.match.usedBase,
    matchName: v.match.holds[0]?.donorName ?? null,
    donors: holds.map((h) => donorRow(v, h, closed)),
    needs: v.needs.map((n) => needRow(v, n)),
    refused: refusals(v),
    receiptUrl: receiptPhoto(v),
    book: bookRows(v),
  };
}
