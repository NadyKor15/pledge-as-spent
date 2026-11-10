import { latestFunded, shownHolds, shownId } from "../derive";
import { donorParts, moneyIn, type Lang } from "../format";
import { meterParts } from "../hold-meter";
import { deriveLedger } from "../ledger/derive";
import { needLabel } from "../ledger/i18n";
import type { DriveView, Hold, LedgerRow, Receipt } from "../types";

// The "river of money" (П2, variant A, Nadya TG 6886): one receipt followed from the store to PayPal in seven steps —
// receipt → readings → lines → shares → PayPal holds & captures → payout → the rest never charged. Read only from the
// drive view and the Ledger's own figures (deriveLedger): no new fields, no calls. Widths are amounts in the drive's
// currency, so every step adds up to the Ledger's totals (tests/app/river-model.test.ts).

export interface RiverShare {
  /** The donor's hold (its renewal chain's first hold, as the book shows it) or the match's. */
  pledgeId: string;
  kind: "donor" | "match";
  /** "Lena · Berlin", "Kitasora Logistics". */
  who: string;
  /** What the share cost in the payer's currency (net of refunds), and in the drive's. */
  amount: number;
  currency: string;
  base: number;
  text: string;
}

export interface RiverNeed {
  needId: string;
  label: string;
  lineNos: number[];
  base: number;
  shares: RiverShare[];
}

export interface RiverRefused {
  lineNo: number;
  item: string;
  base: number;
  text: string;
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
  /** This receipt's shares from this hold, in the payer's currency and in the drive's. */
  captured: number;
  capturedBase: number;
  capturedText: string;
}

export interface RiverNever {
  pledgeId: string;
  who: string;
  /** What PayPal released and never charged, in the donor's currency and in the drive's (Ledger's own figure). */
  amount: number;
  base: number;
  text: string;
  status: string;
}

export interface RiverModel {
  driveId: string;
  baseCurrency: string;
  closed: boolean;
  receipt: { id: string; merchant: string | null; total: number | null; totalText: string; lines: number } | null;
  /** The receipt was read by Meta twice and compared by code: a line passes only when both readings agree. */
  twoReadings: boolean;
  needs: RiverNeed[];
  refused: RiverRefused[];
  holds: RiverHold[];
  payout: { batchId: string | null; to: string | null; amount: number; text: string; status: string } | null;
  /** Donor holds' released rests (the match's own rest is left out, as on the chosen picture). */
  never: RiverNever[];
  totals: { sharesBase: number; donorBase: number; matchBase: number; payoutBase: number; neverBase: number; refusedBase: number };
}

/** A reading path that reads twice and compares (src/receipts/meta-reader.ts): `live:meta`, `cached:meta`, `recognized:meta`. */
export const readTwice = (reader: string | null | undefined): boolean => !!reader && /^(live|cached|recognized):meta$/.test(reader);

const kept = (r: LedgerRow): number => (r.status === "uncollected" ? 0 : (r.amount ?? 0) - (r.reversed ?? 0));
const keptBase = (r: LedgerRow): number => (r.status === "uncollected" ? 0 : r.base);

function who(h: Pick<Hold, "donorName" | "donorCountry" | "kind">): string {
  if (h.kind === "match") return h.donorName;
  const { name, place } = donorParts(h.donorName, h.donorCountry);
  return place ? `${name} · ${place}` : name;
}

/** The river of one receipt: the drive's latest funded one (null receipt before anything was funded). */
export function riverModel(v: DriveView, lang: Lang = "en"): RiverModel {
  const base = v.drive.baseCurrency;
  const ledger = deriveLedger(v, lang);
  const receipt: Receipt | null = latestFunded(v);
  const holds = shownHolds(v);
  const holdOf = (pledgeId: string | null | undefined) => holds.find((h) => h.pledgeId === shownId(v, pledgeId)) ?? holds.find((h) => h.pledgeId === pledgeId);
  const rows = receipt ? v.ledger.filter((r) => r.receiptId === receipt.id) : [];
  const shareRows = rows.filter((r) => (r.kind === "donor_share" || r.kind === "match_share") && r.needId);

  const needs: RiverNeed[] = [];
  for (const r of shareRows) {
    const h = holdOf(r.pledgeId);
    const pledgeId = h?.pledgeId ?? r.pledgeId ?? "";
    let n = needs.find((x) => x.needId === r.needId);
    if (!n) {
      const need = v.needs.find((x) => x.needId === r.needId);
      n = { needId: r.needId as string, label: need ? needLabel(lang, need.needId, need.displayLabel) : (r.needId as string), lineNos: [], base: 0, shares: [] };
      needs.push(n);
    }
    if (r.lineNo !== null && !n.lineNos.includes(r.lineNo)) n.lineNos.push(r.lineNo);
    n.base += keptBase(r);
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
      };
      n.shares.push(s);
    }
    s.amount += kept(r);
    s.base += keptBase(r);
  }
  for (const n of needs) {
    n.lineNos.sort((a, b) => a - b);
    for (const s of n.shares) s.text = moneyIn(lang, s.currency, s.amount);
  }

  const refused: RiverRefused[] = rows
    .filter((r) => r.kind === "rejected" && r.lineNo !== null)
    .map((r) => {
      const line = receipt?.lines.find((l) => l.lineNo === r.lineNo);
      return { lineNo: r.lineNo as number, item: line?.translationEn ?? r.item ?? line?.text ?? "", base: r.base, text: moneyIn(lang, base, r.base) };
    })
    .sort((a, b) => a.lineNo - b.lineNo);

  const funding = holds.filter((h) => shareRows.some((r) => holdOf(r.pledgeId)?.pledgeId === h.pledgeId));
  const riverHolds: RiverHold[] = funding.map((h) => {
    const mine = shareRows.filter((r) => holdOf(r.pledgeId)?.pledgeId === h.pledgeId);
    const captured = mine.reduce((a, r) => a + kept(r), 0);
    const capturedBase = mine.reduce((a, r) => a + keptBase(r), 0);
    const kind = h.kind === "match" ? "match" : "donor";
    return {
      pledgeId: h.pledgeId,
      kind,
      who: who(h),
      authorizationId: h.authorizationId ?? null,
      currency: h.currency,
      authorized: h.authorized,
      authorizedText: moneyIn(lang, h.currency, h.authorized),
      captureIds: [...new Set(mine.flatMap((r) => (r.captureId ? [r.captureId] : [])))],
      captured,
      capturedBase,
      capturedText: moneyIn(lang, h.currency, captured),
    };
  });

  const attempt = receipt ? v.payouts.find((p) => p.receiptId === receipt.id)?.attempts.at(-1) : undefined;
  const payout = attempt
    ? { batchId: attempt.payoutBatchId ?? null, to: v.drive.volunteerName ?? null, amount: attempt.amount, text: moneyIn(lang, base, attempt.amount), status: attempt.status }
    : null;

  // Never charged: the Ledger's own figures per donor (its rest once the hold is over), only for holds that funded
  // this receipt; a live hold keeps its rest and has nothing never charged yet.
  const never: RiverNever[] = riverHolds
    .filter((h) => h.kind === "donor")
    .flatMap((h) => {
      const d = ledger.donors.find((x) => x.pledgeId === h.pledgeId);
      const hold = holds.find((x) => x.pledgeId === h.pledgeId);
      if (!d || !hold) return [];
      const p = d.meter ?? meterParts(hold);
      if (p.never <= 0) return [];
      return [{ pledgeId: h.pledgeId, who: h.who, amount: p.never, base: d.backBase, text: moneyIn(lang, h.currency, p.never), status: hold.status }];
    });

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    driveId: v.drive.id,
    baseCurrency: base,
    closed: v.drive.status === "closed",
    receipt: receipt ? { id: receipt.id, merchant: receipt.merchant, total: receipt.total, totalText: moneyIn(lang, receipt.currency ?? base, receipt.total), lines: receipt.lines.length } : null,
    twoReadings: readTwice(receipt?.reader),
    needs,
    refused,
    holds: riverHolds,
    payout,
    never,
    totals: {
      sharesBase: sum(needs.map((n) => n.base)),
      donorBase: sum(riverHolds.filter((h) => h.kind === "donor").map((h) => h.capturedBase)),
      matchBase: sum(riverHolds.filter((h) => h.kind === "match").map((h) => h.capturedBase)),
      payoutBase: payout?.amount ?? 0,
      neverBase: sum(never.map((n) => n.base)),
      refusedBase: sum(refused.map((r) => r.base)),
    },
  };
}
