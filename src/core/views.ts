import { CoreError } from "./errors";
import type { LineFunded } from "./events";
import { shareIdOf } from "./ids";
import {
  availableMinor,
  capacityBase,
  type HoldBook,
  type LedgerState,
  lookup,
  matchRatio,
  requireDrive,
  requirePledge,
} from "./ledger";
import { toBase } from "./money";
import type { CurrencyCode, HoldStatus, Money, PledgeKind } from "./types";

// Read-only projections of the book for screens and the grid.

export interface PledgeBalance {
  pledgeId: string;
  kind: PledgeKind;
  donorName: string;
  needId: string | null;
  status: HoldStatus;
  revoked: boolean;
  currency: CurrencyCode;
  /** The pledge as made, in the donor's currency. */
  pledged: number;
  authorized: number;
  captured: number;
  capturePending: number;
  accrued: number;
  released: number;
  uncollected: number;
  available: number;
  capacityBase: number;
  authorizationId: string | null;
  expiresAt: string | null;
}

export function pledgeBalance(s: LedgerState, pledgeId: string): PledgeBalance {
  const { pledge, hold } = requirePledge(s, pledgeId);
  return {
    pledgeId,
    kind: pledge.kind,
    donorName: pledge.donorName,
    needId: pledge.needId,
    status: pledge.status,
    revoked: Boolean(hold.revokedAt),
    currency: pledge.amount.currency,
    pledged: pledge.amount.minor,
    authorized: hold.authorized,
    captured: hold.captured,
    capturePending: hold.capturePending,
    accrued: hold.accrued,
    released: hold.released,
    uncollected: hold.uncollected,
    available: availableMinor(pledge, hold),
    capacityBase: capacityBase(pledge, hold),
    authorizationId: hold.authorizationIds[hold.authorizationIds.length - 1] ?? null,
    expiresAt: pledge.expiresAt ?? null,
  };
}

function fundedLines(s: LedgerState): LineFunded[] {
  const out: LineFunded[] = [];
  for (const key of s.lineKeys) {
    const ev = s.lines[key].event;
    if (ev.type === "LineFunded") out.push(ev);
  }
  return out;
}

export interface NeedProgress {
  needId: string;
  label: string;
  unit: string;
  qtyNeeded: number;
  qtyCovered: number;
  remainingQty: number;
  covered: boolean;
  fundedBase: number;
  donorBase: number;
  matchBase: number;
  unfundedBase: number;
  /** Refused because the need was covered. */
  rejectedBase: number;
  /** What the need's donor holds can still fund. */
  donorCapacityBase: number;
}

export function needProgress(s: LedgerState, needId: string): NeedProgress {
  const need = lookup(s.needs, needId);
  if (!need) throw new CoreError("unknown_need", `need ${needId}`);
  const p: NeedProgress = {
    needId,
    label: need.label,
    unit: need.unit,
    qtyNeeded: need.qtyNeeded,
    qtyCovered: s.qtyCovered[needId],
    remainingQty: need.qtyNeeded - s.qtyCovered[needId],
    covered: s.qtyCovered[needId] >= need.qtyNeeded,
    fundedBase: 0,
    donorBase: 0,
    matchBase: 0,
    unfundedBase: 0,
    rejectedBase: 0,
    donorCapacityBase: 0,
  };
  for (const ev of fundedLines(s)) {
    if (ev.line.needId !== needId) continue;
    p.fundedBase += ev.fundedBase;
    p.donorBase += ev.donorBase;
    p.matchBase += ev.matchBase;
    p.unfundedBase += ev.unfundedBase;
    p.rejectedBase += ev.rejectedBase;
  }
  for (const key of s.lineKeys) {
    const ev = s.lines[key].event;
    if (ev.type === "LineRejected" && ev.needId === needId && ev.code === "need_covered") p.rejectedBase += ev.amountBase;
  }
  for (const id of s.pledgeIds) {
    const pledge = s.pledges[id];
    if (pledge.kind === "donor" && pledge.needId === needId) p.donorCapacityBase += capacityBase(pledge, s.holds[id]);
  }
  return p;
}

export interface MatchProgress {
  ratio: { num: number; den: number } | null;
  /** Authorized match holds, in base (floor). */
  pledgedBase: number;
  /** Match shares on funded lines, in base. */
  usedBase: number;
  /** What the live match holds can still fund. */
  capacityBase: number;
  holds: PledgeBalance[];
}

export function matchProgress(s: LedgerState): MatchProgress {
  const holds = s.pledgeIds.filter((id) => s.pledges[id].kind === "match").map((id) => pledgeBalance(s, id));
  let usedBase = 0;
  for (const ev of fundedLines(s)) usedBase += ev.matchBase;
  return {
    ratio: matchRatio(s),
    pledgedBase: holds.reduce((a, h) => a + toBase(h.authorized, s.pledges[h.pledgeId].fx, "floor"), 0),
    usedBase,
    capacityBase: holds.reduce((a, h) => a + h.capacityBase, 0),
    holds,
  };
}

export type ShareStatus = "accrued" | "capture_pending" | "captured" | "uncollected" | "nothing_to_capture";

interface ShareState {
  status: ShareStatus;
  captureId: string | null;
  requestId: string | null;
}

function shareState(hold: HoldBook, shareId: string, quoteMinor: number): ShareState {
  if (quoteMinor === 0) return { status: "nothing_to_capture", captureId: null, requestId: null };
  for (const b of hold.batches) {
    if (b.status === "failed" || !b.shares.some((a) => a.shareId === shareId)) continue;
    return {
      status: b.status === "confirmed" ? "captured" : "capture_pending",
      captureId: b.captureId ?? null,
      requestId: b.requestId,
    };
  }
  if (hold.accruals.some((a) => a.shareId === shareId)) return { status: "accrued", captureId: null, requestId: null };
  if (hold.uncollectedShareIds.includes(shareId)) return { status: "uncollected", captureId: null, requestId: null };
  throw new CoreError("invariant_violation", `share ${shareId} is nowhere in its hold`);
}

export interface StatementRow {
  receiptId: string;
  lineNo: number;
  needId: string;
  item: string;
  unit: string;
  qty: number;
  shareBase: number;
  share: Money;
  /** Match money this share unlocked, in base. */
  matchBase: number;
  captureId: string | null;
  requestId: string | null;
  status: ShareStatus;
  at: string;
}

export interface DonorStatement {
  pledgeId: string;
  donorName: string;
  baseCurrency: CurrencyCode;
  currency: CurrencyCode;
  rows: StatementRow[];
  totals: { shareBase: number; share: number; matchBase: number; helpBase: number };
  balance: PledgeBalance;
}

/** "Your EUR 4.00 bought this, and unlocked this much of the match." */
export function donorStatement(s: LedgerState, pledgeId: string): DonorStatement {
  const drive = requireDrive(s);
  const { pledge, hold } = requirePledge(s, pledgeId);
  const rows: StatementRow[] = [];
  for (const ev of fundedLines(s)) {
    const sh = ev.shares.find((x) => x.pledgeId === pledgeId);
    if (!sh) continue;
    const key = `${ev.line.receiptId}:${ev.line.lineNo}`;
    const need = s.needs[ev.line.needId];
    const st = shareState(hold, shareIdOf(key, pledgeId), sh.quote.minor);
    rows.push({
      receiptId: ev.line.receiptId,
      lineNo: ev.line.lineNo,
      needId: need.id,
      item: need.label,
      unit: need.unit,
      qty: ev.acceptedQty,
      shareBase: sh.base,
      share: { ...sh.quote },
      matchBase: sh.matchBase,
      captureId: st.captureId,
      requestId: st.requestId,
      status: st.status,
      at: ev.at,
    });
  }
  const shareBase = rows.reduce((a, r) => a + r.shareBase, 0);
  const matchBase = rows.reduce((a, r) => a + r.matchBase, 0);
  return {
    pledgeId,
    donorName: pledge.donorName,
    baseCurrency: drive.baseCurrency,
    currency: pledge.amount.currency,
    rows,
    totals: { shareBase, share: rows.reduce((a, r) => a + r.share.minor, 0), matchBase, helpBase: shareBase + matchBase },
    balance: pledgeBalance(s, pledgeId),
  };
}

export type LedgerRowKind = "donor_share" | "match_share" | "rejected" | "unfunded";

export interface LedgerRow {
  rowId: string;
  at: string;
  receiptId: string;
  lineNo: number;
  needId: string | null;
  item: string | null;
  qty: number | null;
  kind: LedgerRowKind;
  pledgeId: string | null;
  donorName: string | null;
  baseCurrency: CurrencyCode;
  base: number;
  currency: CurrencyCode | null;
  amount: number | null;
  matchBase: number;
  status: ShareStatus | "rejected" | "unfunded";
  captureId: string | null;
  code: string | null;
  reasonEn: string | null;
}

/** Flat rows for the grid: one per share, plus refused and unfunded parts of lines. */
export function ledgerRows(s: LedgerState): LedgerRow[] {
  const drive = requireDrive(s);
  const rows: LedgerRow[] = [];
  for (const key of s.lineKeys) {
    const ev = s.lines[key].event;
    if (ev.type === "LineRejected") {
      rows.push({
        rowId: `${key}/rejected`,
        at: ev.at,
        receiptId: ev.receiptId,
        lineNo: ev.lineNo,
        needId: ev.needId,
        item: ev.needId ? s.needs[ev.needId].label : null,
        qty: ev.needQty,
        kind: "rejected",
        pledgeId: null,
        donorName: null,
        baseCurrency: drive.baseCurrency,
        base: ev.amountBase,
        currency: null,
        amount: null,
        matchBase: 0,
        status: "rejected",
        captureId: null,
        code: ev.code,
        reasonEn: ev.reasonEn,
      });
      continue;
    }
    const need = s.needs[ev.line.needId];
    const common = {
      at: ev.at,
      receiptId: ev.line.receiptId,
      lineNo: ev.line.lineNo,
      needId: need.id,
      item: need.label,
      baseCurrency: drive.baseCurrency,
    };
    for (const sh of ev.shares) {
      const pledge = s.pledges[sh.pledgeId];
      const st = shareState(s.holds[sh.pledgeId], shareIdOf(key, sh.pledgeId), sh.quote.minor);
      rows.push({
        ...common,
        rowId: `${key}/${sh.pledgeId}`,
        qty: ev.acceptedQty,
        kind: sh.kind === "donor" ? "donor_share" : "match_share",
        pledgeId: sh.pledgeId,
        donorName: pledge.donorName,
        base: sh.base,
        currency: sh.quote.currency,
        amount: sh.quote.minor,
        matchBase: sh.matchBase,
        status: st.status,
        captureId: st.captureId,
        code: null,
        reasonEn: null,
      });
    }
    if (ev.rejectedBase > 0 || ev.rejectedQty > 0) {
      rows.push({
        ...common,
        rowId: `${key}/need_covered`,
        qty: ev.rejectedQty,
        kind: "rejected",
        pledgeId: null,
        donorName: null,
        base: ev.rejectedBase,
        currency: null,
        amount: null,
        matchBase: 0,
        status: "rejected",
        captureId: null,
        code: "need_covered",
        reasonEn: `${need.label}: only ${ev.acceptedQty} of ${ev.line.needQty} were still needed.`,
      });
    }
    if (ev.unfundedBase > 0) {
      rows.push({
        ...common,
        rowId: `${key}/unfunded`,
        qty: null,
        kind: "unfunded",
        pledgeId: null,
        donorName: null,
        base: ev.unfundedBase,
        currency: null,
        amount: null,
        matchBase: 0,
        status: "unfunded",
        captureId: null,
        code: "not_enough_pledges",
        reasonEn: `Not enough pledges for ${need.label} to cover this line.`,
      });
    }
  }
  return rows;
}

export interface CloseReportRow {
  pledgeId: string;
  donorName: string;
  kind: PledgeKind;
  currency: CurrencyCode;
  pledged: number;
  spent: number;
  released: number;
  /** pledged === spent + released: true once the hold is settled. */
  settled: boolean;
}

/** SPEC §6: per authorized hold, "pledged / spent / released" in the donor's currency. */
export function closeReport(s: LedgerState): CloseReportRow[] {
  return s.pledgeIds
    .filter((id) => s.holds[id].authorized > 0)
    .map((id) => {
      const { pledge, hold } = requirePledge(s, id);
      return {
        pledgeId: id,
        donorName: pledge.donorName,
        kind: pledge.kind,
        currency: pledge.amount.currency,
        pledged: hold.authorized,
        spent: hold.captured,
        released: hold.released,
        settled: hold.authorized === hold.captured + hold.released,
      };
    });
}
