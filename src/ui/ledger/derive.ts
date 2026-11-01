import { toBase } from "@/core/money";
import { holdById, latestFunded, lineName, needById } from "../derive";
import { donorParts, money, ofCount, pct, shortName, titleParts } from "../format";
import type { DriveView, Hold, LedgerRow, Need } from "../types";
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
  /** Money that went back: all that was not spent, once the hold is over. */
  back: number;
  /** Money a live hold still keeps. */
  held: number;
  spentText: string;
  /** What did not go to the shelter, with the word for it. */
  restText: string;
  restWord: "back" | "held";
  /** The same in the drive's currency: these add up to the totals, and weigh the arcs. */
  pledgedBase: number;
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
  /** promised = spent + held + returned, exactly: each is the sum of the donors' own figures. */
  promised: number;
  spent: number;
  held: number;
  returned: number;
  /** The third total: what went back on a closed drive, what is still held on any other. */
  rest: number;
  restLabel: string;
  /** The line under Held when part of the money has already gone back. */
  restNote: string | null;
  /** The line under Spent while shares are recorded but PayPal has not captured them. */
  waitingNote: string | null;
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

/** "capture_pending" -> "Capture pending". */
const statusWords = (status: string) => {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "Kitasora Community Shelter — Earthquake relief" -> "Kitasora Shelter", as the card calls it. */
export function shelterName(title: string): string {
  return titleParts(title).head.replace(/\bCommunity\s+/, "");
}

/** An amount of a pledge in the drive's currency, rounded down as the core does for what a hold can cover. */
function inBase(h: Pick<Hold, "fx" | "currency">, minor: number, base: string): number {
  if (h.currency === base) return minor;
  return h.fx ? toBase(minor, h.fx, "floor") : 0;
}

/** A hold that can no longer pay and no longer keeps anything. */
const OVER: Hold["status"][] = ["voided", "expired", "captured", "denied"];

/** What a share cost in the donor's currency: nothing if never collected, less what PayPal took back. */
const keptMinor = (r: LedgerRow) => (r.status === "uncollected" ? 0 : (r.amount ?? 0) - (r.reversed ?? 0));

/** The same in the drive's currency. */
function keptBase(r: LedgerRow, h: Hold | undefined, base: string): number {
  if (r.status === "uncollected") return 0;
  const back = r.reversed ?? 0;
  // All of it came back: nothing is left, whatever the rounding of each side says.
  if (back > 0 && back >= (r.amount ?? 0)) return 0;
  return back > 0 && h ? Math.max(0, r.base - inBase(h, back, base)) : r.base;
}

function donorRow(v: DriveView, h: Hold, closed: boolean): LedgerDonor {
  const base = v.drive.baseCurrency;
  const shares = v.ledger.filter((r) => r.kind === "donor_share" && r.pledgeId === h.pledgeId);
  const pledgedBase = inBase(h, h.authorized, base);
  const spentBase = Math.min(
    pledgedBase,
    shares.reduce((sum, r) => sum + keptBase(r, h, base), 0),
  );
  const spent = Math.min(
    h.authorized,
    shares.reduce((sum, r) => sum + keptMinor(r), 0),
  );
  const rest = h.authorized - spent;
  const over = closed || OVER.includes(h.status);

  const city = donorParts(h.donorName).place;
  const name = shortName(h.donorName);
  return {
    pledgeId: h.pledgeId,
    name,
    city,
    label: city ? `${name} · ${city}` : name,
    at: locate(city, h.donorCountry),
    currency: h.currency,
    spent,
    back: over ? rest : 0,
    held: over ? 0 : rest,
    spentText: money(h.currency, spent),
    restText: money(h.currency, rest),
    restWord: over ? "back" : "held",
    pledgedBase,
    spentBase,
    restBase: pledgedBase - spentBase,
    needIds: [...new Set(shares.flatMap((r) => (r.needId ? [r.needId] : [])))],
    lineKeys: [...new Set(shares.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

function needRow(v: DriveView, n: Need): LedgerNeed {
  const lines = v.ledger.filter((r) => r.needId === n.needId);
  return {
    needId: n.needId,
    label: n.displayLabel,
    count: ofCount(n.qtyCovered, n.qtyNeeded, n.unit),
    percent: Math.min(100, pct(n.qtyCovered, n.qtyNeeded)),
    pledgeIds: [...new Set(lines.flatMap((r) => (r.kind === "donor_share" && r.pledgeId ? [r.pledgeId] : [])))],
    // Every line of the need: its refused and unfunded ones are part of its story.
    lineKeys: [...new Set(lines.map((r) => lineKey(r.receiptId, r.lineNo)))],
  };
}

/** What PayPal has actually taken for a row, as the donor's statement counts it. */
function chargedText(r: LedgerRow): string {
  if (r.amount === null || !["captured", "partly_reversed", "reversed"].includes(r.status)) return "—";
  return money(r.currency, r.amount - (r.reversed ?? 0)) || "—";
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
        charged: chargedText(r),
        capture: r.captureId ?? "—",
        status: statusWords(r.status),
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

/** Shares recorded on donors' holds that PayPal has not been asked for, or has not confirmed, yet. */
function waitingBase(v: DriveView): number {
  const base = v.drive.baseCurrency;
  return v.ledger.filter((r) => r.kind === "donor_share" && (r.status === "accrued" || r.status === "capture_pending")).reduce((sum, r) => sum + keptBase(r, holdById(v, r.pledgeId), base), 0);
}

/** Everything the Ledger tab shows. */
export function deriveLedger(v: DriveView): LedgerModel {
  const base = v.drive.baseCurrency;
  const closed = v.drive.status === "closed";
  const donors = v.holds.filter((h) => h.kind === "donor" && h.authorized > 0).map((h) => donorRow(v, h, closed));
  const sum = (pick: (d: LedgerDonor) => number) => donors.reduce((total, d) => total + pick(d), 0);
  const held = sum((d) => (d.restWord === "held" ? d.restBase : 0));
  const returned = sum((d) => (d.restWord === "back" ? d.restBase : 0));
  const waiting = closed ? 0 : waitingBase(v);
  return {
    driveId: v.drive.id,
    phase: closed ? "closed" : "open",
    shelter: shelterName(v.drive.displayTitle),
    baseCurrency: base,
    promised: sum((d) => d.pledgedBase),
    spent: sum((d) => d.spentBase),
    held,
    returned,
    rest: closed ? returned : held,
    restLabel: closed ? "Returned to donors" : "Held",
    restNote: !closed && returned > 0 ? `${money(base, returned)} already returned` : null,
    // The screens say shares are "captured once a day"; a drive may batch on another rhythm.
    waitingNote: waiting > 0 ? `${money(base, waiting)} waiting for the ${v.drive.batch.maxAgeHours === 24 ? "daily" : "next"} capture` : null,
    match: v.ledger.filter((r) => r.kind === "match_share").reduce((total, r) => total + keptBase(r, holdById(v, r.pledgeId), base), 0),
    matchName: v.match.holds[0]?.donorName ?? null,
    donors,
    needs: v.needs.map((n) => needRow(v, n)),
    refused: refusals(v),
    receiptUrl: receiptPhoto(v),
    book: bookRows(v),
  };
}
