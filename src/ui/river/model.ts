import { toBase } from "@/core/money";
import { holdById, latestFunded, shareStage, shownHolds, shownId } from "../derive";
import { donorParts, moneyIn, type Lang } from "../format";
import { meterParts } from "../hold-meter";
import { deriveLedger, keptBase } from "../ledger/derive";
import { needLabel, WORDS } from "../ledger/i18n";
import type { DriveView, Hold, LedgerRow, Receipt } from "../types";

// The river of money (variant A): one receipt followed from the store to PayPal in seven steps — receipt → readings →
// lines → shares → PayPal holds & captures → payout → the rest never charged. Read only from the drive view and the
// Ledger's own figures (deriveLedger, keptBase): no new fields, no calls. Widths are amounts in the drive's currency,
// so every step adds up: the lines to the receipt's total, the shares to the Ledger (tests/app/river-model.test.ts).
//
// Renewals (RENEW): a renewed pledge is read as one hold, its renewal chain's first (shownHolds), as the book reads it.
// Before RENEW is switched on for the river, its hold card must also name the new authorization's id with its amount
// (today it shows the first authorization only).

export interface RiverShare {
  /** The donor's hold (its renewal chain's first hold, as the book shows it) or the match's. */
  pledgeId: string;
  kind: "donor" | "match";
  /** "Lena · Berlin", "Kitasora Logistics". */
  who: string;
  /** What the share cost in the payer's currency, net of refunds and of what could not be collected, and in the drive's. */
  amount: number;
  currency: string;
  base: number;
  /** The donor's share in the donor's currency; the match's in the drive's. */
  text: string;
  /** What its lines cost before any refund, in the payer's currency. */
  gross: number;
  grossText: string;
  /** What PayPal refunded after the capture, in the payer's currency. */
  returned: number;
  returnedText: string | null;
  /** spent: PayPal took it; waiting: approved, not taken yet; uncollected: PayPal could not take it. */
  state: "spent" | "waiting" | "uncollected";
}

export interface RiverNeed {
  needId: string;
  label: string;
  lineNos: number[];
  /** The shares, net of refunds (the Ledger's figures), in the drive's currency. */
  base: number;
  /** What its lines cost on the receipt, in the drive's currency: this flows in from the receipt. */
  gross: number;
  shares: RiverShare[];
}

export interface RiverRefused {
  /** The book's row: a line can be part funded, part refused or unfunded. */
  key: string;
  lineNo: number;
  /** Null when only part of the line is refused or unfunded ("part of line 5"). */
  item: string | null;
  base: number;
  text: string;
  /** rejected: the rules refused it; unfunded: not enough pledges for it. */
  kind: "rejected" | "unfunded";
  part: boolean;
}

export interface RiverHold {
  pledgeId: string;
  kind: "donor" | "match";
  who: string;
  /** PayPal's authorization id: the hold. */
  authorizationId: string | null;
  currency: string;
  authorized: number;
  authorizedText: string;
  /** PayPal's capture ids for this receipt's shares from this hold. */
  captureIds: string[];
  /** This receipt's shares from this hold, in the payer's currency and in the drive's (net, as the Ledger counts). */
  captured: number;
  capturedBase: number;
  capturedText: string;
  /** captured: PayPal took this receipt's shares; waiting: not yet; uncollected: PayPal could not take them. */
  state: "captured" | "waiting" | "uncollected";
  /** This receipt's shares PayPal could not collect, in the payer's currency. */
  uncollected: number;
  uncollectedText: string | null;
  /** The same hold's shares on the drive's other receipts: the hold adds up with them. */
  otherReceipts: number;
  otherText: string | null;
}

export interface RiverNever {
  pledgeId: string;
  who: string;
  /** Released by PayPal and never charged (with what could not be collected), in the donor's currency and the drive's. */
  amount: number;
  base: number;
  text: string;
  /** Charged, then refunded by PayPal: returned, not "never charged". */
  returned: number;
  returnedBase: number;
  returnedText: string | null;
  status: string;
}

export interface RiverModel {
  driveId: string;
  baseCurrency: string;
  closed: boolean;
  /** Closed and every hold is over (voided, expired, captured): nothing more can be charged. */
  final: boolean;
  /** How many receipts of the drive moved money: with more than one, the sums are this receipt's. */
  receipts: number;
  receipt: { id: string; merchant: string | null; total: number | null; totalText: string; lines: number } | null;
  /** The receipt was read by Meta twice and compared by code: a line passes only when both readings agree. */
  twoReadings: boolean;
  /** The Ledger's word for the donors' money: "approved" while some of it waits for capture. */
  spentLabel: string;
  needs: RiverNeed[];
  refused: RiverRefused[];
  holds: RiverHold[];
  /** confirmed: PayPal paid it (SUCCESS); only then does money flow into it. */
  payout: { batchId: string | null; to: string | null; amount: number; text: string; status: string; confirmed: boolean } | null;
  /** Donor holds' rests (the match's own rest is left out, as on the chosen picture). */
  never: RiverNever[];
  totals: {
    sharesBase: number;
    donorBase: number;
    matchBase: number;
    /** What the funded lines cost: with the refused and the unfunded, the receipt's total. */
    grossBase: number;
    refusedBase: number;
    unfundedBase: number;
    /** Only a payout PayPal confirmed. */
    payoutBase: number;
    neverBase: number;
    returnedBase: number;
  };
}

/** A reading path that reads twice and compares (src/receipts/meta-reader.ts): `live:meta`, `cached:meta`, `recognized:meta`. */
export const readTwice = (reader: string | null | undefined): boolean => !!reader && /^(live|cached|recognized):meta$/.test(reader);

const kept = (r: LedgerRow): number => (r.status === "uncollected" ? 0 : (r.amount ?? 0) - (r.reversed ?? 0));
const OVER = new Set<Hold["status"]>(["voided", "expired", "captured"]);

/** An amount of a hold in the drive's currency, rounded down as the Ledger does (ledger/derive.ts inBase). */
const inBase = (h: Pick<Hold, "fx" | "currency">, minor: number, base: string): number => (h.currency === base ? minor : h.fx ? toBase(minor, h.fx, "floor") : 0);

function who(h: Pick<Hold, "donorName" | "donorCountry" | "kind">): string {
  if (h.kind === "match") return h.donorName;
  const { name, place } = donorParts(h.donorName, h.donorCountry);
  return place ? `${name} · ${place}` : name;
}

/** The river of one receipt: the drive's latest funded one (null receipt before anything was funded). */
export function riverModel(v: DriveView, lang: Lang = "en"): RiverModel {
  const base = v.drive.baseCurrency;
  const closed = v.drive.status === "closed";
  const ledger = deriveLedger(v, lang);
  const receipt: Receipt | null = latestFunded(v);
  const holds = shownHolds(v);
  const holdOf = (pledgeId: string | null | undefined) => holds.find((h) => h.pledgeId === shownId(v, pledgeId)) ?? holds.find((h) => h.pledgeId === pledgeId);
  const isShare = (r: LedgerRow) => (r.kind === "donor_share" || r.kind === "match_share") && !!r.needId;
  const rows = receipt ? v.ledger.filter((r) => r.receiptId === receipt.id) : [];
  const shareRows = rows.filter(isShare);
  const keptB = (r: LedgerRow) => keptBase(r, holdById(v, r.pledgeId), base);

  const needs: RiverNeed[] = [];
  const states = new Map<RiverShare, string[]>();
  const grossBase = new Map<RiverShare, number>();
  for (const r of shareRows) {
    const h = holdOf(r.pledgeId);
    const pledgeId = h?.pledgeId ?? r.pledgeId ?? "";
    let n = needs.find((x) => x.needId === r.needId);
    if (!n) {
      const need = v.needs.find((x) => x.needId === r.needId);
      n = { needId: r.needId as string, label: need ? needLabel(lang, need.needId, need.displayLabel) : (r.needId as string), lineNos: [], base: 0, gross: 0, shares: [] };
      needs.push(n);
    }
    if (r.lineNo !== null && !n.lineNos.includes(r.lineNo)) n.lineNos.push(r.lineNo);
    n.base += keptB(r);
    n.gross += r.base;
    let s = n.shares.find((x) => x.pledgeId === pledgeId);
    if (!s) {
      s = {
        pledgeId,
        kind: r.kind === "match_share" ? "match" : "donor",
        who: h ? who(h) : (r.donorName ?? "—"),
        amount: 0,
        currency: r.currency ?? base,
        base: 0,
        text: "",
        gross: 0,
        grossText: "",
        returned: 0,
        returnedText: null,
        state: "spent",
      };
      n.shares.push(s);
      states.set(s, []);
    }
    s.amount += kept(r);
    s.base += keptB(r);
    s.gross += r.amount ?? 0;
    grossBase.set(s, (grossBase.get(s) ?? 0) + r.base);
    if (r.status !== "uncollected") s.returned += r.reversed ?? 0;
    states.get(s)!.push(r.status);
  }
  for (const n of needs) {
    n.lineNos.sort((a, b) => a - b);
    for (const s of n.shares) {
      const st = states.get(s)!;
      s.state = st.every((x) => x === "uncollected") ? "uncollected" : st.some((x) => shareStage(x) === "waiting") ? "waiting" : "spent";
      // The match's share in the drive's currency, whatever the currency of its hold.
      s.text = s.kind === "match" ? moneyIn(lang, base, s.base) : moneyIn(lang, s.currency, s.amount);
      s.grossText = s.kind === "match" ? moneyIn(lang, base, grossBase.get(s) ?? 0) : moneyIn(lang, s.currency, s.gross);
      s.returnedText = s.returned > 0 ? moneyIn(lang, s.currency, s.returned) : null;
    }
  }

  // Refused and unfunded parts of lines: they flow nowhere, but they are part of the receipt's total.
  const fundedLines = new Set(shareRows.map((r) => r.lineNo));
  const refused: RiverRefused[] = rows
    .filter((r) => (r.kind === "rejected" || r.kind === "unfunded") && r.lineNo !== null)
    .map((r) => {
      const line = receipt?.lines.find((l) => l.lineNo === r.lineNo);
      // Part of a line ("part of line 5"): the rest of the same line was funded (need_covered, not enough pledges).
      const part = fundedLines.has(r.lineNo);
      return {
        key: r.rowId,
        lineNo: r.lineNo as number,
        item: part ? null : (line?.translationEn ?? r.item ?? line?.text ?? ""),
        base: r.base,
        text: moneyIn(lang, base, r.base),
        kind: r.kind === "unfunded" ? ("unfunded" as const) : ("rejected" as const),
        part,
      };
    })
    .sort((a, b) => a.lineNo - b.lineNo || a.key.localeCompare(b.key));

  const funding = holds.filter((h) => shareRows.some((r) => holdOf(r.pledgeId)?.pledgeId === h.pledgeId));
  const riverHolds: RiverHold[] = funding.map((h) => {
    const mine = shareRows.filter((r) => holdOf(r.pledgeId)?.pledgeId === h.pledgeId);
    const captured = mine.reduce((a, r) => a + kept(r), 0);
    const capturedBase = mine.reduce((a, r) => a + keptB(r), 0);
    const uncollected = mine.filter((r) => r.status === "uncollected").reduce((a, r) => a + (r.amount ?? 0), 0);
    const captureIds = [...new Set(mine.flatMap((r) => (r.captureId ? [r.captureId] : [])))];
    const other = v.ledger.filter((r) => isShare(r) && r.receiptId !== receipt?.id && holdOf(r.pledgeId)?.pledgeId === h.pledgeId).reduce((a, r) => a + kept(r), 0);
    const kind = h.kind === "match" ? "match" : "donor";
    return {
      pledgeId: h.pledgeId,
      kind,
      who: who(h),
      authorizationId: h.authorizationId ?? null,
      currency: h.currency,
      authorized: h.authorized,
      authorizedText: moneyIn(lang, h.currency, h.authorized),
      captureIds,
      captured,
      capturedBase,
      capturedText: moneyIn(lang, h.currency, captured),
      state: captureIds.length > 0 ? "captured" : mine.every((r) => r.status === "uncollected") ? "uncollected" : "waiting",
      uncollected,
      uncollectedText: uncollected > 0 ? moneyIn(lang, h.currency, uncollected) : null,
      otherReceipts: other,
      otherText: other > 0 ? moneyIn(lang, h.currency, other) : null,
    };
  });

  const attempt = receipt ? v.payouts.find((p) => p.receiptId === receipt.id)?.attempts.at(-1) : undefined;
  const payout = attempt
    ? {
        batchId: attempt.payoutBatchId ?? null,
        to: v.drive.volunteerName ?? null,
        amount: attempt.amount,
        text: moneyIn(lang, base, attempt.amount),
        status: attempt.status,
        confirmed: attempt.status === "confirmed",
      }
    : null;

  // The rests: the Ledger's own figure per donor (backBase, what left the hold), split into what PayPal released and
  // never charged and what it refunded after a capture (returned) — the refund at the Ledger's own rate. Only for holds
  // that funded this receipt; a live hold keeps its rest and has nothing never charged yet.
  const never: RiverNever[] = riverHolds
    .filter((h) => h.kind === "donor")
    .flatMap((h) => {
      const d = ledger.donors.find((x) => x.pledgeId === h.pledgeId);
      const hold = holds.find((x) => x.pledgeId === h.pledgeId);
      if (!d || !hold) return [];
      const p = d.meter ?? meterParts(hold);
      if (p.never <= 0 && p.back <= 0) return [];
      const root = holdById(v, h.pledgeId) ?? hold;
      const returnedBase = Math.min(d.backBase, inBase(root, p.back, base));
      return [
        {
          pledgeId: h.pledgeId,
          who: h.who,
          amount: p.never,
          base: d.backBase - returnedBase,
          text: moneyIn(lang, h.currency, p.never),
          returned: p.back,
          returnedBase,
          returnedText: p.back > 0 ? moneyIn(lang, h.currency, p.back) : null,
          status: hold.status,
        },
      ];
    });

  // The Ledger's word for the donors' money (deriveLedger spentLabel), for this receipt.
  const W = WORDS[lang];
  const waitingHere = !closed && shareRows.some((r) => r.kind === "donor_share" && shareStage(r.status) === "waiting");
  const spentLabel = v.match.holds[0] ? (waitingHere ? W.donorsApproved : W.donorsSpent) : waitingHere ? W.approvedForNeeds : W.spentOnNeeds;

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    driveId: v.drive.id,
    baseCurrency: base,
    closed,
    final: closed && holds.filter((h) => h.authorized > 0).every((h) => OVER.has(h.status)),
    receipts: v.receipts.filter((r) => r.status === "funded").length,
    receipt: receipt ? { id: receipt.id, merchant: receipt.merchant, total: receipt.total, totalText: moneyIn(lang, receipt.currency ?? base, receipt.total), lines: receipt.lines.length } : null,
    twoReadings: readTwice(receipt?.reader),
    spentLabel,
    needs,
    refused,
    holds: riverHolds,
    payout,
    never,
    totals: {
      sharesBase: sum(needs.map((n) => n.base)),
      donorBase: sum(riverHolds.filter((h) => h.kind === "donor").map((h) => h.capturedBase)),
      matchBase: sum(riverHolds.filter((h) => h.kind === "match").map((h) => h.capturedBase)),
      grossBase: sum(needs.map((n) => n.gross)),
      refusedBase: sum(refused.filter((r) => r.kind === "rejected").map((r) => r.base)),
      unfundedBase: sum(refused.filter((r) => r.kind === "unfunded").map((r) => r.base)),
      payoutBase: payout?.confirmed ? payout.amount : 0,
      neverBase: sum(never.map((n) => n.base)),
      returnedBase: sum(never.map((n) => n.returnedBase)),
    },
  };
}
