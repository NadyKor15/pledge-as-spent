import { CoreError } from "./errors";
import type { PledgeRenewed } from "./events";
import { renewalPledgeId, renewedEventId } from "./ids";
import { availableMinor, isLiveStatus, pendingRenewal, promised, renewalRefusal, requireDrive, requirePledge, type LedgerState, type RebindRefusal } from "./ledger";
import { donorStatement, type StatementRow } from "./views";
import { addMs, DAY_MS, parseTime, RENEWAL_FROM_DAY, HOLD_LIFE_DAYS } from "./time";
import type { Money, Pledge } from "./types";

export { renewalRefusal } from "./ledger";

// PayPal ends a hold 29 days after the donor's first approval, and a reauthorize
// keeps that day. A donor whose hold still has money nobody spent can renew it:
// a NEW order for that rest, approved again in the PayPal window. The book links
// the two holds (PledgeRenewed): the old one captures what it owes and is voided,
// the new one funds the same need from then on. There are no e-mails: the
// statement shows the end date and, in the last 3 days, a reminder.

/** The statement reminds from this many days before the hold's end (day 26 of 29). */
export const RENEWAL_REMIND_DAYS = HOLD_LIFE_DAYS - RENEWAL_FROM_DAY;

/**
 * The pledge to create for a renewal of `pledgeId` at `at`: the same donor, need,
 * currency, locked rate and rest choice, for what the hold has not promised yet.
 * Its id is derived (`<id>.r<n>`), so a double click asks PayPal for the same order.
 * The caller fills in `paypal.orderId`. A CoreError("renewal_refused") names the rule.
 */
export function renewalPledge(s: LedgerState, pledgeId: string, at: string): Pledge {
  parseTime(at, "at");
  const refusal = renewalRefusal(s, pledgeId, at);
  if (refusal) throw new CoreError("renewal_refused", `${refusal.code}: ${refusal.reasonEn}`);
  const { pledge, hold } = requirePledge(s, pledgeId);
  const p: Pledge = {
    id: renewalPledgeId(pledgeId, (hold.renewals?.length ?? 0) + 1),
    driveId: pledge.driveId,
    kind: "donor",
    needId: pledge.needId,
    donorName: pledge.donorName,
    ...(pledge.donorCountry ? { donorCountry: pledge.donorCountry } : {}),
    ...(pledge.rest !== undefined ? { rest: pledge.rest } : {}),
    ...(pledge.rules !== undefined ? { rules: JSON.parse(JSON.stringify(pledge.rules)) as Pledge["rules"] } : {}),
    renews: pledgeId,
    amount: { currency: pledge.amount.currency, minor: availableMinor(pledge, hold) },
    fx: { ...pledge.fx },
    paypal: { orderId: "-" },
    status: "pending_approval",
  };
  return p;
}

export interface RenewalOffer {
  pledgeId: string;
  /** The hold's own status (a renewed hold says "voided" only once PayPal released it). */
  status: Pledge["status"] | null;
  /** When PayPal ends the hold by itself (29 days from the first approval); null before approval. */
  expiresAt: string | null;
  /** From here on the statement reminds the donor (3 days before the end). */
  remindFrom: string | null;
  /** `now` is past `remindFrom` and the hold may still be renewed. */
  remind: boolean;
  /** What a renewal would carry on, in the donor's currency. */
  available: Money;
  /** Why it may not be renewed now, or null. */
  refusal: RebindRefusal | null;
  /**
   * A renewal under way: waiting for the donor's approval in PayPal (the button resumes it:
   * the same order), or approved and about to be linked. `amount` is that order's amount.
   */
  pending: { pledgeId: string; amount: Money; approved: boolean } | null;
  /** The renewal that carries this hold on, once approved. */
  renewedTo: string | null;
  /** The hold this one carries on, when it is a renewal. */
  renews: string | null;
}

/** What the donor's statement shows about the end of this hold and its renewal, at `now`. */
export function renewalOffer(s: LedgerState, pledgeId: string, now: string): RenewalOffer {
  requireDrive(s);
  parseTime(now, "now");
  const refusal = renewalRefusal(s, pledgeId, now);
  const pledge = s.pledges[pledgeId];
  const hold = s.holds[pledgeId];
  if (!pledge || !hold) {
    return { pledgeId, status: null, expiresAt: null, remindFrom: null, remind: false, available: { currency: "USD", minor: 0 }, refusal, pending: null, renewedTo: null, renews: null };
  }
  const expiresAt = pledge.expiresAt ?? null;
  const remindFrom = expiresAt ? addMs(expiresAt, -RENEWAL_REMIND_DAYS * DAY_MS) : null;
  const pending = pendingRenewal(s, hold);
  // A renewal under way is not a refusal: the statement shows it and lets the donor finish (or withdraw) it.
  const shown = refusal?.code === "renewal_pending" ? null : refusal;
  const waiting = pending ? s.pledges[pending] : null;
  return {
    pledgeId,
    status: pledge.status,
    expiresAt,
    remindFrom,
    remind: shown === null && remindFrom !== null && parseTime(now) >= parseTime(remindFrom),
    available: { currency: pledge.amount.currency, minor: availableMinor(pledge, hold) },
    refusal: shown,
    pending: waiting ? { pledgeId: waiting.id, amount: { ...waiting.amount }, approved: waiting.status !== "pending_approval" } : null,
    renewedTo: hold.renewedTo ?? null,
    renews: pledge.renews ?? null,
  };
}

/**
 * The links due at `at`: every approved, live, not yet linked renewal whose old
 * hold is not renewed yet. The caller appends them right after the renewal's
 * authorization, in the same transaction; this also picks up one a crash left.
 */
export function planRenewals(s: LedgerState, at: string): PledgeRenewed[] {
  const drive = requireDrive(s);
  parseTime(at, "at");
  const out: PledgeRenewed[] = [];
  const linked = new Set<string>();
  for (const id of s.pledgeIds) {
    const p = s.pledges[id];
    const h = s.holds[id];
    if (p.renews === undefined || h.usable !== undefined || !isLiveStatus(p.status) || h.revokedAt || h.blockedAt) continue;
    const old = s.holds[p.renews];
    // never two links for one old hold; nothing is carried on from a withdrawn one (that renewal is voided instead)
    if (!old || old.renewedTo || old.revokedAt || linked.has(p.renews)) continue;
    linked.add(p.renews);
    out.push({ id: renewedEventId(drive.id, id), at, driveId: drive.id, type: "PledgeRenewed", pledgeId: id, fromPledgeId: p.renews });
  }
  return out;
}

export interface ChainMember {
  pledgeId: string;
  status: Pledge["status"];
  authorized: number;
  /** A linked renewal: the most it may promise; null on the first hold. */
  usable: number | null;
  captured: number;
  released: number;
  expiresAt: string | null;
  /** When this hold was carried on by the next one. */
  renewedAt: string | null;
  renews: string | null;
  renewedTo: string | null;
}

export interface ChainEvent {
  at: string;
  kind: "pledged" | "renewed" | "ended";
  pledgeId: string;
  note: string;
}

/**
 * One donor's renewed pledge as ONE history, the same whichever hold's id it is
 * asked for. Totals in the donor's currency, read like a single hold: pledged is
 * the first hold's amount; charged, waiting, back and uncollected are summed;
 * held is what the latest live hold can still pay (never a renewal's surplus);
 * never is the rest of the pledge, released by PayPal and never charged.
 */
export interface ChainStatement {
  first: string;
  latest: string;
  currency: Money["currency"];
  members: ChainMember[];
  events: ChainEvent[];
  rows: (StatementRow & { pledgeId: string })[];
  totals: { pledged: number; charged: number; waiting: number; held: number; returning: number; never: number; back: number; uncollected: number };
}

/** The chain's history, or null when the pledge was never renewed (and renews nothing). */
export function chainStatement(s: LedgerState, pledgeId: string): ChainStatement | null {
  requirePledge(s, pledgeId);
  const ids = renewalChain(s, pledgeId);
  if (ids.length === 1) return null;
  const members: ChainMember[] = ids.map((id) => {
    const p = s.pledges[id];
    const h = s.holds[id];
    return {
      pledgeId: id,
      status: p.status,
      authorized: h.authorized,
      usable: h.usable ?? null,
      captured: h.captured,
      released: h.released,
      expiresAt: p.expiresAt ?? null,
      renewedAt: h.renewedAt ?? null,
      renews: p.renews ?? null,
      renewedTo: h.renewedTo ?? null,
    };
  });
  const root = s.pledges[ids[0]];
  const latestId = ids[ids.length - 1];
  const latest = s.pledges[latestId];
  const lh = s.holds[latestId];
  const sum = (k: "captured" | "capturePending" | "accrued" | "uncollected" | "reversed") => ids.reduce((a, id) => a + s.holds[id][k], 0);
  const pledged = s.holds[ids[0]].authorized;
  const charged = sum("captured");
  const waiting = sum("accrued") + sum("capturePending");
  const uncollected = sum("uncollected");
  const back = sum("reversed");
  const live = isLiveStatus(latest.status);
  const rest = live ? Math.max(0, (lh.usable ?? lh.authorized) - promised(lh)) : 0;
  const over = !live && latest.status !== "pending_approval";
  const returning = live && lh.revokedAt ? rest : 0;
  const released = Math.max(0, pledged - charged - waiting - uncollected - back - rest);
  const events: ChainEvent[] = [];
  if (root.authorizedAt) events.push({ at: root.authorizedAt, kind: "pledged", pledgeId: root.id, note: `approved in PayPal: ${root.amount.minor} ${root.amount.currency}` });
  for (const m of members) {
    if (m.renewedTo && m.renewedAt) {
      const next = s.pledges[m.renewedTo];
      events.push({ at: m.renewedAt, kind: "renewed", pledgeId: m.renewedTo, note: `renewed: a new order for ${next.amount.minor} ${next.amount.currency}, approved again; it may use ${s.holds[m.renewedTo].usable ?? 0}` });
    }
    const ended = s.holds[m.pledgeId].endedAt;
    if (ended) events.push({ at: ended, kind: "ended", pledgeId: m.pledgeId, note: `${m.status}: ${m.released} released by PayPal, never charged` });
  }
  events.sort((a, b) => parseTime(a.at) - parseTime(b.at));
  const rows = ids.flatMap((id) => donorStatement(s, id).rows.map((r) => ({ ...r, pledgeId: id }))).sort((a, b) => parseTime(a.at) - parseTime(b.at));
  return {
    first: ids[0],
    latest: latestId,
    currency: root.amount.currency,
    members,
    events,
    rows,
    totals: {
      pledged,
      charged,
      waiting,
      held: rest - returning + (over || returning > 0 ? 0 : uncollected),
      returning: returning + (!over && returning > 0 ? uncollected : 0),
      never: released + (over ? uncollected : 0),
      back,
      uncollected,
    },
  };
}

/** The ids of a hold's chain, first hold to latest renewal. */
export function renewalChain(s: LedgerState, pledgeId: string): string[] {
  let first = pledgeId;
  for (let i = 0; i < 100 && s.pledges[first]?.renews; i++) first = s.pledges[first].renews!;
  const out = [first];
  for (let i = 0; i < 100; i++) {
    const next = s.holds[out[out.length - 1]]?.renewedTo;
    if (!next) break;
    out.push(next);
  }
  return out;
}
