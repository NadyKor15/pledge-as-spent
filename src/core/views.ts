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
  restOf,
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
  reversed: number;
  available: number;
  capacityBase: number;
  /** A capture was refused for good; the hold only waits for its void. */
  blocked: boolean;
  blockedReason: string | null;
  authorizationId: string | null;
  expiresAt: string | null;
  /** The donor moved the rest of this hold from one need to another (once), or null. */
  rebound?: { at: string; fromNeedId: string; toNeedId: string; by: string; via: string } | null;
  /** The donor's choice at the pledge for the rest; absent: no choice was made, which is "release". */
  rest?: "release" | "carry";
  /** Carries that followed that choice, oldest first; absent until the first one. */
  carried?: { at: string; fromNeedId: string; toNeedId: string }[];
  /** A renewal: the hold it carries on (absent otherwise). One donor's chain is one pledge on screens. */
  renews?: string;
  /** The approved renewal that carries this hold on (absent until then). */
  renewedTo?: string;
  /** A renewal: held at PayPal above what it may promise, never charged (absent on other holds; 0 once the hold ended). */
  surplus?: number;
  /** A linked renewal: the most it may ever promise, i.e. what it carried on from the old hold (stays after its end). */
  usable?: number;
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
    reversed: hold.reversed,
    available: availableMinor(pledge, hold),
    capacityBase: capacityBase(pledge, hold),
    blocked: Boolean(hold.blockedAt),
    blockedReason: hold.blockedReason ?? null,
    authorizationId: hold.authorizationIds[hold.authorizationIds.length - 1] ?? null,
    expiresAt: pledge.expiresAt ?? null,
    rebound: hold.rebound ? { ...hold.rebound } : null,
    // Only when the donor made a choice or the rest moved: views of books made before stay byte for byte the same.
    ...(pledge.rest !== undefined ? { rest: restOf(pledge) } : {}),
    ...(hold.carried?.length ? { carried: hold.carried.map((c) => ({ ...c })) } : {}),
    ...(pledge.renews !== undefined ? { renews: pledge.renews } : {}),
    ...(hold.renewedTo ? { renewedTo: hold.renewedTo } : {}),
    ...(hold.surplus ? { surplus: hold.surplus } : {}),
    ...(hold.usable !== undefined ? { usable: hold.usable } : {}),
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

export type ShareStatus =
  | "accrued"
  | "capture_pending"
  | "captured"
  | "partly_reversed"
  | "reversed"
  | "uncollected"
  | "nothing_to_capture";

interface ShareState {
  status: ShareStatus;
  captureId: string | null;
  requestId: string | null;
  /** Pledge-currency minor units PayPal took back from this share. */
  reversed: number;
  uncollectedReason: string | null;
}

function shareState(hold: HoldBook, shareId: string, quoteMinor: number): ShareState {
  const none = { captureId: null, requestId: null, reversed: 0, uncollectedReason: null };
  if (quoteMinor === 0) return { ...none, status: "nothing_to_capture" };
  for (const b of hold.batches) {
    if (b.status === "failed" || !b.shares.some((a) => a.shareId === shareId)) continue;
    const reversed = b.reversedByShare[shareId] ?? 0;
    const status: ShareStatus =
      b.status === "pending" ? "capture_pending" : reversed === 0 ? "captured" : reversed >= quoteMinor ? "reversed" : "partly_reversed";
    return { status, captureId: b.captureId ?? null, requestId: b.requestId, reversed, uncollectedReason: null };
  }
  if (hold.accruals.some((a) => a.shareId === shareId)) return { ...none, status: "accrued" };
  if (hold.uncollectedShareIds.includes(shareId)) {
    return { ...none, status: "uncollected", uncollectedReason: hold.uncollectedReasons[shareId] ?? null };
  }
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
  /** Taken back by PayPal after capture, in the donor's currency. */
  reversed: number;
  uncollectedReason: string | null;
  /** false: funded after the hold's honor period. */
  honored: boolean | null;
  at: string;
}

export interface DonorStatement {
  pledgeId: string;
  donorName: string;
  baseCurrency: CurrencyCode;
  currency: CurrencyCode;
  rows: StatementRow[];
  totals: {
    shareBase: number;
    /** All of the donor's shares in their currency, charged or not. */
    share: number;
    /** What the donor was actually charged: captured shares, minus reversals. */
    charged: number;
    uncollected: number;
    reversed: number;
    matchBase: number;
    helpBase: number;
  };
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
      reversed: st.reversed,
      uncollectedReason: st.uncollectedReason,
      honored: sh.honored ?? null,
      at: ev.at,
    });
  }
  const shareBase = rows.reduce((a, r) => a + r.shareBase, 0);
  const matchBase = rows.reduce((a, r) => a + r.matchBase, 0);
  const sumIf = (pick: (r: StatementRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const isCaptured = (r: StatementRow) => r.status === "captured" || r.status === "partly_reversed" || r.status === "reversed";
  return {
    pledgeId,
    donorName: pledge.donorName,
    baseCurrency: drive.baseCurrency,
    currency: pledge.amount.currency,
    rows,
    totals: {
      shareBase,
      share: sumIf((r) => r.share.minor),
      charged: sumIf((r) => (isCaptured(r) ? r.share.minor - r.reversed : 0)),
      uncollected: sumIf((r) => (r.status === "uncollected" ? r.share.minor : 0)),
      reversed: sumIf((r) => r.reversed),
      matchBase,
      helpBase: shareBase + matchBase,
    },
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
  /** Share rows: what PayPal took back after capture, in the donor's currency. */
  reversed: number | null;
  honored: boolean | null;
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
        reversed: null,
        honored: null,
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
        reversed: st.reversed,
        honored: sh.honored ?? null,
        code: st.uncollectedReason ? "uncollected" : null,
        reasonEn: st.uncollectedReason,
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
        reversed: null,
        honored: null,
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
        reversed: null,
        honored: null,
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
  /** Captured and kept. */
  spent: number;
  /** Let go unused. */
  released: number;
  /** Promised to purchases but never collected (the volunteer was paid): shown, not folded into released. */
  uncollected: number;
  /** Captured, then taken back by PayPal. */
  reversed: number;
  /** pledged === spent + released + uncollected + reversed: true once the hold is settled. */
  settled: boolean;
}

/** SPEC §6: per authorized hold, "pledged / spent / released" (+ uncollected, reversed) in the donor's currency. */
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
        uncollected: hold.uncollected,
        reversed: hold.reversed,
        settled: hold.authorized === hold.captured + hold.released + hold.uncollected + hold.reversed,
      };
    });
}
