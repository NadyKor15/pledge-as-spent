import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateLine } from "./allocate";
import type { LedgerEvent, LineFunded } from "./events";
import { lineKeyOf, shareIdOf } from "./ids";
import {
  applyEvent,
  availableMinor,
  capacityBase,
  consecutiveFailures,
  emptyLedger,
  isFundable,
  isLiveStatus,
  type LedgerState,
  matchRatio,
  promised,
  receiptFundedBase,
  replay,
  uncommitted,
  unsettledHolds,
  volunteerCommitted,
} from "./ledger";
import { minorRate } from "./money";
import {
  captureReversedEvent,
  captureSubmittedEvent,
  holdExpiredEvent,
  payoutSubmittedEvent,
  planCaptures,
  planClose,
  planHoldMaintenance,
  planPayout,
  renewalRequestedEvent,
} from "./plan";
import { rebindEvent } from "./rebind";
import { planCarries } from "./carry";
import { planRenewals, renewalChain, renewalPledge } from "./renew";
import { arbRate, CURRENCIES, RUNS } from "./testing/arbitraries";
import { makeDrive, makePledge } from "./testing/builders";
import { classifyCaptureFailure, MAX_CAPTURE_ATTEMPTS } from "./refusals";
import { addMs, CAPTURE_RETRY_BASE_MS, HOUR_MS, REBIND_BEFORE_EXPIRY_MS } from "./time";
import type { CurrencyCode, FundableLineInput, Need, PaymentSource, Pledge } from "./types";
import { closeReport, donorStatement } from "./views";

// ---- scenario generators ----------------------------------------------------

type Approval = PaymentSource | "pending" | "denied";

type Op =
  | { k: "advance"; hours: number }
  | { k: "capture"; force: boolean }
  | { k: "resolve"; pick: number; ok: boolean; reason: number }
  | { k: "reverse"; pick: number; frac: number; again: boolean }
  | { k: "outage"; pick: number }
  | { k: "maintain"; newAuthId: boolean }
  | { k: "repeatLine"; pick: number }
  | { k: "repeatEvent"; pick: number }
  | { k: "revoke"; pick: number }
  | { k: "authorize"; pick: number; source: PaymentSource }
  | { k: "newPledge"; needIdx: number; curIdx: number; minor: number; match: boolean }
  | { k: "payout"; pick: number; ok: boolean }
  | { k: "rebind"; pick: number; needIdx: number; repeat: boolean }
  | { k: "renew"; pick: number; approve: "now" | "later" | "card" }
  | { k: "approveRenewal"; pick: number; deny: boolean }
  | { k: "removeVolunteer"; pick: number };

interface LineSpec {
  needIdx: number;
  qty: number;
  amount: number;
  receipt: number;
}

const arbApproval = fc.constantFrom<Approval>("paypal", "paypal", "card", "card", "pending", "denied");

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant("advance" as const), hours: fc.double({ min: 0, max: 48, noNaN: true }) }) },
  // jumps of days, so holds reach reauthorize (day 4), renewal (day 26) and expiry (day 29)
  { weight: 2, arbitrary: fc.record({ k: fc.constant("advance" as const), hours: fc.double({ min: 24, max: 240, noNaN: true }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("capture" as const), force: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("resolve" as const), pick: fc.nat(), ok: fc.boolean(), reason: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("reverse" as const), pick: fc.nat(), frac: fc.double({ min: 0, max: 1, noNaN: true }), again: fc.boolean() }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("maintain" as const), newAuthId: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("repeatLine" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("repeatEvent" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("revoke" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("authorize" as const), pick: fc.nat(), source: fc.constantFrom<PaymentSource>("paypal", "card") }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("newPledge" as const),
      needIdx: fc.nat(),
      curIdx: fc.nat(),
      minor: fc.integer({ min: 1, max: 300_000 }),
      match: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("payout" as const), pick: fc.nat(), ok: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("outage" as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("rebind" as const), pick: fc.nat(), needIdx: fc.nat(), repeat: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("renew" as const), pick: fc.nat(), approve: fc.constantFrom<"now" | "later" | "card">("now", "later", "card") }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("approveRenewal" as const), pick: fc.nat(), deny: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("removeVolunteer" as const), pick: fc.nat() }) },
);

const arbScenario = fc.record({
  base: fc.constantFrom(...CURRENCIES),
  currencies: fc.uniqueArray(fc.constantFrom(...CURRENCIES), { minLength: 1, maxLength: 6 }),
  rates: fc.array(arbRate(), { minLength: 6, maxLength: 6 }),
  needs: fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 8 }),
  holds: fc.array(
    fc.record({ needIdx: fc.nat(), curIdx: fc.nat(), minor: fc.integer({ min: 1, max: 300_000 }), approval: arbApproval, carry: fc.boolean() }),
    { minLength: 1, maxLength: 30, size: "max" },
  ),
  match: fc.option(
    fc.record({
      curIdx: fc.nat(),
      minor: fc.integer({ min: 1, max: 1_000_000 }),
      ratioNum: fc.integer({ min: 1, max: 3 }),
      ratioDen: fc.integer({ min: 1, max: 3 }),
      count: fc.integer({ min: 1, max: 2 }),
    }),
    { nil: null },
  ),
  lines: fc.array(
    fc.record({ needIdx: fc.nat(), qty: fc.integer({ min: 1, max: 25 }), amount: fc.integer({ min: 0, max: 100_000 }), receipt: fc.integer({ min: 0, max: 3 }) }),
    { minLength: 1, maxLength: 60, size: "max" },
  ),
  ops: fc.array(fc.record({ op: arbOp, slot: fc.nat() }), { maxLength: 60, size: "max" }),
  threshold: fc.option(fc.integer({ min: 1, max: 50_000 }), { nil: null }),
  /** Invited volunteers (none: the drive pays its own address, as before); a limit in the drive's currency or none. */
  volunteers: fc.array(fc.option(fc.integer({ min: 1, max: 200_000 }), { nil: null }), { maxLength: 3 }),
  maxAgeHours: fc.integer({ min: 1, max: 72 }),
});

type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

/** Refusals as the server words them: retryable, unknown (bounded) and terminal. */
const REFUSALS = [
  "500 INTERNAL_SERVER_ERROR",
  "503 SERVICE_UNAVAILABLE",
  "429 RATE_LIMIT_REACHED",
  "capture 7XY DECLINED",
  "422 UNPROCESSABLE_ENTITY INSTRUMENT_DECLINED (debug_id f00)",
  "422 UNPROCESSABLE_ENTITY AUTHORIZATION_VOIDED",
];

/** The pledge every drive keeps unapproved until after it closes. */
const LATE = "zz-late";

// ---- invariants -------------------------------------------------------------

const abs = (n: bigint) => (n < 0n ? -n : n);

/** Plain throw instead of expect(): this runs after every event of every run. */
function must(ok: boolean, what: string, ctx: unknown): void {
  if (!ok) throw new Error(`invariant broken: ${what} ${JSON.stringify(ctx)}`);
}

function checkState(s: LedgerState): void {
  for (const id of s.pledgeIds) {
    const p = s.pledges[id];
    const h = s.holds[id];
    const ctx = { id, status: p.status, h: { ...h, accruals: h.accruals.length, batches: h.batches.length } };
    for (const v of [h.authorized, h.captured, h.capturePending, h.accrued, h.released, h.uncollected]) {
      must(Number.isSafeInteger(v) && v >= 0, "buckets are non-negative integers", ctx);
    }
    // captured + capturePending + accrued (+ released) never exceed the hold
    // captured + capturePending + accrued + uncollected + reversed + released never exceed the hold
    must(uncommitted(h) >= 0, "buckets never exceed the authorization", ctx);
    must(h.accrued === h.accruals.reduce((a, x) => a + x.minor, 0), "accrued = sum of accruals", ctx);
    let pending = 0;
    let pendingCount = 0;
    let confirmedKept = 0;
    let reversed = 0;
    for (const b of h.batches) {
      must(b.reversed >= 0 && b.reversed <= b.amount && (b.status === "confirmed" || b.reversed === 0), "a batch reverses at most what it captured", ctx);
      must(Object.values(b.reversedByShare).reduce((a, x) => a + x, 0) === b.reversed, "reversal split over shares adds up", ctx);
      for (const a of b.shares) must((b.reversedByShare[a.shareId] ?? 0) <= a.minor, "no share reversed beyond itself", ctx);
      reversed += b.reversed;
      if (b.status === "pending") {
        pending += b.amount;
        pendingCount += 1;
      } else if (b.status === "confirmed") confirmedKept += b.amount - b.reversed;
    }
    must(h.capturePending === pending, "capturePending = pending batches", ctx);
    must(h.captured === confirmedKept, "captured = confirmed batches minus reversals", ctx);
    must(h.reversed === reversed, "reversed = sum of batch reversals", ctx);
    must(pendingCount <= 1, "one capture in flight per hold", ctx);
    must(consecutiveFailures(h) <= MAX_CAPTURE_ATTEMPTS, "refused attempts are bounded", ctx);
    if (h.blockedAt) must(availableMinor(p, h) === 0 && h.accrued === 0, "a blocked hold funds and accrues nothing", ctx);
    // every charged share sits in exactly one place: accrued, a live batch, or uncollected
    const where = new Map<string, number>();
    const seen = (sid: string) => where.set(sid, (where.get(sid) ?? 0) + 1);
    h.accruals.forEach((a) => seen(a.shareId));
    h.batches.filter((b) => b.status !== "failed").forEach((b) => b.shares.forEach((a) => seen(a.shareId)));
    h.uncollectedShareIds.forEach(seen);
    let uncollected = 0;
    for (const key of s.lineKeys) {
      const ev = s.lines[key].event;
      if (ev.type !== "LineFunded") continue;
      const sh = ev.shares.find((x) => x.pledgeId === id);
      if (!sh || sh.quote.minor === 0) continue;
      const sid = shareIdOf(lineKeyOf(ev.line.receiptId, ev.line.lineNo), id);
      must(where.get(sid) === 1, "each share is in exactly one place", { ...ctx, sid, n: where.get(sid) ?? 0 });
      where.delete(sid);
      if (h.uncollectedShareIds.includes(sid)) uncollected += sh.quote.minor;
    }
    must(where.size === 0, "no share outside the book's lines", ctx);
    must(h.uncollected === uncollected, "uncollected = its shares", ctx);
    must(availableMinor(p, h) <= uncommitted(h), "available <= uncommitted", ctx);
    if (p.status === "voided" || p.status === "expired") {
      must(h.accrued === 0 && uncommitted(h) === 0, "an ended hold keeps nothing", ctx);
    }
    if (p.status === "captured") must(h.captured + h.reversed === h.authorized, "captured status means fully captured", ctx);
    if (p.status === "pending_approval" || p.status === "denied") must(h.authorized === 0, "no hold before approval", ctx);
    if (p.kind === "match" && p.fx.base === p.fx.quote) {
      // same-currency match: the ceiling holds exactly in base too
      let usedBase = 0;
      for (const key of s.lineKeys) {
        const ev = s.lines[key].event;
        if (ev.type === "LineFunded") usedBase += ev.shares.find((x) => x.pledgeId === id)?.base ?? 0;
      }
      must(usedBase <= h.authorized, "match never above its ceiling", { ...ctx, usedBase });
    }
  }
  for (const id of s.needIds) must(s.qtyCovered[id] <= s.needs[id].qtyNeeded, "need never over-covered", id);
  // Volunteers: never paid (in flight or confirmed) above their limit; a drive with volunteers names one on every payout.
  for (const id of s.volunteerIds) {
    const v = s.volunteers[id];
    const c = volunteerCommitted(s, id);
    if (v.limitBase !== null) must(c.pending + c.paid <= v.limitBase, "a volunteer is never paid above their limit", { id, c, limit: v.limitBase });
  }
  for (const [rid, attempts] of Object.entries(s.payouts)) {
    for (const a of attempts) {
      if (s.volunteerIds.length > 0) must(a.volunteerId !== undefined && Object.hasOwn(s.volunteers, a.volunteerId), "a payout names an invited volunteer", { rid, a });
      must(attempts.every((x) => x.volunteerId === a.volunteerId), "every payout of a receipt goes to one volunteer", { rid });
    }
  }
  // Renewals: a chain (first hold -> linked renewals) never promises more than the donor's first hold.
  for (const id of s.pledgeIds) {
    const p = s.pledges[id];
    const h = s.holds[id];
    if (p.renews !== undefined) {
      const linked = h.usable !== undefined;
      if (!linked) must(promised(h) === 0 && availableMinor(p, h) === 0, "an unlinked renewal promises nothing", { id });
      else must(h.usable! + (h.surplus ?? 0) <= h.authorized && promised(h) <= h.usable!, "a linked renewal promises at most its usable part", { id, h: { usable: h.usable, surplus: h.surplus, authorized: h.authorized } });
      continue;
    }
    if (h.authorized === 0) continue;
    const chain = renewalChain(s, id);
    const total = chain.reduce((a, c) => a + promised(s.holds[c]), 0);
    must(total <= h.authorized, "a renewal chain never promises more than the first hold", { id, chain, total, authorized: h.authorized });
    for (const c of chain.slice(0, -1)) must(availableMinor(s.pledges[c], s.holds[c]) === 0, "a renewed hold funds nothing new", { c });
  }
}

function checkLine(pre: LedgerState, line: FundableLineInput, ev: LedgerEvent, now: string): void {
  const need = pre.needs[line.needId];
  const covered = pre.qtyCovered[need.id];
  if (pre.drive!.status !== "open") {
    expect(ev).toMatchObject({ type: "LineRejected", code: "drive_closed" });
    return;
  }
  if (covered >= need.qtyNeeded) {
    // a covered need is never funded
    expect(ev).toMatchObject({ type: "LineRejected", code: "need_covered", amountBase: line.amountBase });
    return;
  }
  expect(ev.type).toBe("LineFunded");
  const e = ev as LineFunded;
  const accepted = Math.min(line.needQty, need.qtyNeeded - covered);
  const F = accepted === line.needQty ? line.amountBase : Math.floor((line.amountBase * accepted) / line.needQty);
  expect(e.acceptedQty).toBe(accepted);
  expect(e.fundedBase + e.unfundedBase).toBe(F);
  expect(F + e.rejectedBase).toBe(line.amountBase);

  // shares add up to the funded amount exactly
  expect(e.shares.reduce((a, x) => a + x.base, 0)).toBe(e.fundedBase);
  expect(e.shares.filter((x) => x.kind === "donor").reduce((a, x) => a + x.base, 0)).toBe(e.donorBase);
  expect(e.shares.filter((x) => x.kind === "match").reduce((a, x) => a + x.base, 0)).toBe(e.matchBase);
  expect(e.shares.reduce((a, x) => a + x.matchBase, 0)).toBe(e.matchBase);

  // capacities as the engine must have seen them
  const caps = new Map<string, number>();
  for (const id of pre.pledgeIds) {
    const p = pre.pledges[id];
    if (isFundable(p, pre.holds[id], now)) caps.set(id, capacityBase(p, pre.holds[id]));
  }
  const donorIds = [...caps.keys()].filter((id) => pre.pledges[id].kind === "donor" && pre.pledges[id].needId === need.id && caps.get(id)! > 0);
  const matchIds = [...caps.keys()].filter((id) => pre.pledges[id].kind === "match" && caps.get(id)! > 0);
  const D = donorIds.reduce((a, id) => a + caps.get(id)!, 0);
  const M = matchIds.reduce((a, id) => a + caps.get(id)!, 0);
  expect(e.donorCapacityBase).toBe(D);
  expect(e.matchCapacityBase).toBe(M);

  // SPEC §3.2 restated: m0 = min(M, m_ideal); d = min(D, F - m0); m cut to floor(d*r) when donors fall short
  const r = matchRatio(pre);
  const rn = BigInt(r?.num ?? 0);
  const rd = BigInt(r?.den ?? 1);
  const mIdeal = Number((BigInt(F) * rn) / (rn + rd));
  const m0 = Math.min(M, mIdeal);
  const dNeed = F - m0;
  const d = Math.min(D, dNeed);
  const m = d < dNeed ? Math.min(m0, Number((BigInt(d) * rn) / rd)) : m0;
  expect([e.donorBase, e.matchBase]).toEqual([d, m]);
  expect(e.matchBase).toBeLessThanOrEqual(M);
  expect(BigInt(e.matchBase) * rd).toBeLessThanOrEqual(BigInt(e.donorBase) * rn);
  if (e.unfundedBase > 0) expect(e.donorBase).toBe(D);

  for (const sh of e.shares) {
    const p = pre.pledges[sh.pledgeId];
    const h = pre.holds[sh.pledgeId];
    expect(caps.has(sh.pledgeId)).toBe(true);
    expect(sh.base).toBeGreaterThan(0);
    expect(sh.base).toBeLessThanOrEqual(caps.get(sh.pledgeId)!);
    expect(sh.quote.minor).toBeLessThanOrEqual(availableMinor(p, h));
    // conversion error at most one minor unit of the hold, in base
    const k = minorRate(p.fx);
    expect(abs(BigInt(sh.quote.minor) * k.num - BigInt(sh.base) * k.den) <= k.num).toBe(true);
    // largest remainder: within one unit of the exact proportional share
    const pool = sh.kind === "donor" ? D : M;
    const total = sh.kind === "donor" ? e.donorBase : e.matchBase;
    expect(abs(BigInt(sh.base) * BigInt(pool) - BigInt(total) * BigInt(caps.get(sh.pledgeId)!)) < BigInt(pool)).toBe(true);
    if (sh.kind === "donor") expect(p.needId).toBe(need.id);
  }
  // every backer with a non-zero proportional share is present
  for (const id of [...donorIds, ...matchIds]) {
    const isDonor = donorIds.includes(id);
    const total = BigInt(isDonor ? e.donorBase : e.matchBase);
    const pool = BigInt(isDonor ? D : M);
    if (total * BigInt(caps.get(id)!) >= pool) expect(e.shares.some((x) => x.pledgeId === id)).toBe(true);
  }
}

// ---- the simulation ---------------------------------------------------------

const T0 = "2026-11-02T00:00:00.000Z";

class Sim {
  state: LedgerState = emptyLedger();
  events: LedgerEvent[] = [];
  now = T0;
  lines: { line: FundableLineInput; ev: LedgerEvent }[] = [];
  requestIds = new Set<string>();
  /** Holds the donor moved: the need they left, and when. */
  rebinds = new Map<string, { from: string; to: string; at: string }>();
  private n = 0;

  constructor(readonly sc: Scenario) {}

  id(prefix: string) {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }

  apply(e: LedgerEvent) {
    this.state = applyEvent(this.state, e);
    this.events.push(e);
    checkState(this.state);
  }

  currency(idx: number): CurrencyCode {
    return this.sc.currencies[idx % this.sc.currencies.length];
  }

  rate(c: CurrencyCode): string {
    return c === this.sc.base ? "1" : this.sc.rates[CURRENCIES.indexOf(c)];
  }

  addPledge(id: string, kind: "donor" | "match", needId: string | null, c: CurrencyCode, minor: number, approval: Approval, carry = false) {
    const ratio = this.sc.match ? { ratioNum: this.sc.match.ratioNum, ratioDen: this.sc.match.ratioDen } : undefined;
    const rest = kind === "donor" && carry ? ("carry" as const) : undefined;
    const pledge: Pledge = makePledge({ id, kind, needId, amount: { currency: c, minor }, rate: this.rate(c), ratio, baseCurrency: this.sc.base, rest });
    this.apply({ id: this.id("pc"), at: this.now, driveId: "drv1", type: "PledgeCreated", pledge });
    if (approval === "denied") this.apply({ id: this.id("pd"), at: this.now, driveId: "drv1", type: "PledgeDenied", pledgeId: id });
    else if (approval !== "pending") this.authorize(id, approval);
  }

  authorize(pledgeId: string, source: PaymentSource) {
    this.apply({ id: this.id("pa"), at: this.now, driveId: "drv1", type: "PledgeAuthorized", pledgeId, authorizationId: `AUTH-${pledgeId}`, paymentSource: source });
    this.carry(); // a hold approved for a need that is already covered moves at once
  }

  carries = 0;

  /**
   * The service's step after every funded line and authorization: apply the
   * carries due. Each is checked against an independent reading of the rule,
   * and planning again right after gives nothing (no hold is left behind).
   */
  carry() {
    const s = this.state;
    const evs = planCarries(s, this.now);
    for (const ev of evs) {
      const before = this.state;
      const p = before.pledges[ev.pledgeId];
      const h = before.holds[ev.pledgeId];
      must(p.kind === "donor" && p.rest === "carry" && p.needId === ev.fromNeedId, "only a donor who chose to keep the rest is carried, from the need the hold backs", ev);
      must(before.qtyCovered[ev.fromNeedId] >= before.needs[ev.fromNeedId].qtyNeeded, "a carry leaves only a covered need", ev);
      must(before.qtyCovered[ev.toNeedId] < before.needs[ev.toNeedId].qtyNeeded, "a carry goes only to an open need", ev);
      must(capacityBase(p, h) > 0 && Date.parse(this.now) < Date.parse(p.expiresAt!) - REBIND_BEFORE_EXPIRY_MS, "a carry moves something that can still fund in time", ev);
      // independent reading of "the open need that lacks the most, ties by the drive's order"
      let best: string | null = null;
      for (const id of before.needIds) {
        if (id === p.needId) continue;
        const lack = before.needs[id].qtyNeeded - before.qtyCovered[id];
        if (lack <= 0) continue;
        if (best === null) best = id;
        else {
          const bl = before.needs[best].qtyNeeded - before.qtyCovered[best];
          if (lack / before.needs[id].qtyNeeded > bl / before.needs[best].qtyNeeded + 1e-12) best = id;
        }
      }
      must(ev.toNeedId === best, "the rest goes to the need that lacks the most", { ev, best });
      this.apply(ev);
      const after = this.state.holds[ev.pledgeId];
      for (const k of ["authorized", "captured", "capturePending", "accrued", "released", "uncollected", "reversed"] as const) must(after[k] === h[k], "a carry leaves the hold's money as it was", { ev, k });
      must(JSON.stringify(after.authorizationIds) === JSON.stringify(h.authorizationIds), "a carry keeps PayPal's authorization", ev);
      expect(planHoldMaintenance(this.state, this.now)).toEqual(planHoldMaintenance(before, this.now));
      expect(applyEvent(this.state, ev)).toBe(this.state);
      this.rebinds.set(ev.pledgeId, { from: ev.fromNeedId, to: ev.toNeedId, at: this.now });
      this.carries += 1;
    }
    expect(planCarries(this.state, this.now)).toEqual([]);
  }

  open() {
    const sc = this.sc;
    const needs: Need[] = sc.needs.map((q, i) => ({ id: `n${i}`, driveId: "drv1", label: `need ${i}`, unit: "unit", qtyNeeded: q }));
    const drive = makeDrive({
      baseCurrency: sc.base,
      batch: { maxAgeHours: sc.maxAgeHours, thresholdMinor: sc.threshold ? { [sc.base]: sc.threshold } : {} },
    });
    this.apply({ id: "open", at: T0, driveId: "drv1", type: "DriveOpened", drive, needs });
    sc.holds.forEach((h, i) => this.addPledge(`d${String(i).padStart(2, "0")}`, "donor", `n${h.needIdx % needs.length}`, this.currency(h.curIdx), h.minor, h.approval, h.carry));
    if (sc.match) {
      for (let j = 0; j < sc.match.count; j++) this.addPledge(`m${j}`, "match", null, this.currency(sc.match.curIdx + j), sc.match.minor, "paypal");
    }
    this.addPledge(LATE, "donor", "n0", sc.base, 1000, "pending");
    sc.volunteers.forEach((limit, i) =>
      this.apply({ id: `vol-${i}`, at: T0, driveId: "drv1", type: "VolunteerInvited", volunteer: { id: `v${i}`, name: `Volunteer ${i}`, payoutEmail: `v${i}@example.com`, tokenHash: `t${i}`, limitBase: limit, firstReceiptCheck: true }, by: "coordinator" }),
    );
  }

  volunteerPaid = 0;
  volunteerRefused = 0;

  /** The volunteer who brought a receipt: receipts are spread over the invited volunteers. */
  volunteerOf(receiptId: string): string | undefined {
    const n = this.sc.volunteers.length;
    return n === 0 ? undefined : `v${Number(receiptId.slice(1)) % n}`;
  }

  fund(spec: LineSpec) {
    const line: FundableLineInput = {
      receiptId: `r${spec.receipt}`,
      lineNo: this.lines.length + 1,
      needId: `n${spec.needIdx % this.sc.needs.length}`,
      needQty: spec.qty,
      amountBase: spec.amount,
    };
    const pre = this.state;
    const ev = allocateLine(pre, line, this.now)!;
    expect(ev).not.toBeNull();
    expect(allocateLine(pre, line, this.now)).toEqual(ev); // deterministic
    checkLine(pre, line, ev, this.now);
    if (ev.type === "LineFunded") {
      for (const sh of ev.shares) {
        const moved = this.rebinds.get(sh.pledgeId);
        // after a rebind the old need gets not a cent from that hold
        if (moved) must(line.needId !== moved.from && line.needId === moved.to, "a moved hold funds only its new need", { pledge: sh.pledgeId, moved, need: line.needId });
      }
    }
    this.apply(ev);
    this.lines.push({ line, ev });
    this.carry();
  }

  capture(force: boolean) {
    for (const c of planCaptures(this.state, this.now, { force })) {
      const h = this.state.holds[c.pledgeId];
      if (c.retry) {
        expect(h.batches.find((b) => b.status === "pending")!.requestId).toBe(c.requestId);
        continue;
      }
      must(!h.blockedAt, "no capture planned on a blocked hold", c);
      const refused = consecutiveFailures(h);
      if (refused > 0 && !force) {
        const last = h.batches[h.batches.length - 1];
        must(Date.parse(this.now) >= Date.parse(last.resolvedAt!) + CAPTURE_RETRY_BASE_MS * 2 ** (refused - 1), "a refused hold waits out its backoff", c);
      }
      expect(c.requestId).toBe(`cap:drv1:${c.pledgeId}:${h.nextSeq}`);
      expect(this.requestIds.has(c.requestId)).toBe(false); // a new batch never reuses an id
      expect(c.amount.minor).toBe(h.accrued);
      expect(c.finalCapture).toBe(false);
      this.requestIds.add(c.requestId);
      this.apply(captureSubmittedEvent(c, this.now));
    }
  }

  pendingBatches() {
    return this.state.pledgeIds.flatMap((id) =>
      this.state.holds[id].batches.filter((b) => b.status === "pending").map((b) => ({ pledgeId: id, b })),
    );
  }

  resolve(pick: number, ok: boolean, reasonIdx = 0) {
    const pending = this.pendingBatches();
    if (pending.length === 0) return;
    const { pledgeId, b } = pending[pick % pending.length];
    if (ok) {
      const currency = this.state.pledges[pledgeId].amount.currency;
      this.apply({ id: this.id("cc"), at: this.now, driveId: "drv1", type: "CaptureConfirmed", pledgeId, requestId: b.requestId, captureId: `CAP-${b.requestId}`, amount: { currency, minor: b.amount } });
      return;
    }
    const reason = REFUSALS[reasonIdx % REFUSALS.length];
    const live = isLiveStatus(this.state.pledges[pledgeId].status);
    const before = this.state.holds[pledgeId];
    this.apply({ id: this.id("cf"), at: this.now, driveId: "drv1", type: "CaptureFailed", pledgeId, requestId: b.requestId, reason });
    const h = this.state.holds[pledgeId];
    const terminal = classifyCaptureFailure(reason).terminal || consecutiveFailures(h) >= MAX_CAPTURE_ATTEMPTS;
    if (!live) must(h.uncollected === before.uncollected + b.amount, "a refusal after the hold ended is uncollected", { pledgeId });
    else if (terminal) must(Boolean(h.blockedAt) && h.accrued === 0 && h.uncollected === before.uncollected + before.accrued + b.amount, "a terminal refusal uncollects the hold's shares", { pledgeId, reason });
    else must(!h.blockedAt && h.accrued === before.accrued + b.amount, "a retryable refusal returns the shares to accrued", { pledgeId, reason });
  }

  /** PayPal keeps answering 500 for one hold: after the bounded attempts its shares are uncollected. */
  outage(pick: number) {
    const s = this.state;
    const ids = s.pledgeIds.filter((id) => isLiveStatus(s.pledges[id].status) && !s.holds[id].blockedAt && s.holds[id].accrued > 0 && !s.holds[id].batches.some((b) => b.status === "pending"));
    if (ids.length === 0) return;
    const id = ids[pick % ids.length];
    if (Date.parse(this.now) >= Date.parse(s.pledges[id].expiresAt!)) return;
    for (let i = 0; i < MAX_CAPTURE_ATTEMPTS && !this.state.holds[id].blockedAt; i++) {
      const c = planCaptures(this.state, this.now, { force: true }).find((x) => x.pledgeId === id && !x.retry)!;
      expect(c).toBeDefined();
      this.requestIds.add(c.requestId);
      this.apply(captureSubmittedEvent(c, this.now));
      this.resolve(this.pendingBatches().findIndex((x) => x.pledgeId === id), false, 0);
    }
    const h = this.state.holds[id];
    must(Boolean(h.blockedAt) && h.accrued === 0 && /refused attempts/.test(h.blockedReason ?? ""), "the attempt bound ends an outage", { id, reason: h.blockedReason });
  }

  reverse(pick: number, frac: number, again: boolean) {
    const s = this.state;
    const open = s.pledgeIds.flatMap((id) => s.holds[id].batches.filter((b) => b.status === "confirmed" && b.amount > b.reversed).map((b) => ({ id, b })));
    if (open.length === 0) return;
    const { id, b } = open[pick % open.length];
    const amount = Math.max(1, Math.floor((b.amount - b.reversed) * frac));
    const ev = captureReversedEvent(s, { captureId: b.captureId!, amount: { currency: s.pledges[id].amount.currency, minor: amount }, reason: "PAYMENT.CAPTURE.REVERSED", at: this.now, reversalId: this.id("rev") })!;
    expect(ev).toMatchObject({ pledgeId: id, requestId: b.requestId });
    const capturedBefore = s.holds[id].captured;
    this.apply(ev);
    must(this.state.holds[id].captured === capturedBefore - amount, "a reversal moves exactly its amount out of captured", { id, amount });
    if (again) expect(applyEvent(this.state, { ...ev, id: `${ev.id}-again` })).toBe(this.state); // same reversal id
  }

  maintain(newAuthId: boolean) {
    for (const c of planHoldMaintenance(this.state, this.now)) {
      const p = this.state.pledges[c.pledgeId];
      const h = this.state.holds[c.pledgeId];
      expect(isLiveStatus(p.status)).toBe(true);
      if (c.kind === "reauthorize") {
        expect(p.paymentSource).toBe("paypal");
        expect(h.reauths.length).toBe(0);
        expect(Date.parse(this.now) - Date.parse(p.authorizedAt!)).toBeGreaterThanOrEqual(4 * 24 * HOUR_MS);
        this.apply({ id: this.id("ra"), at: this.now, driveId: "drv1", type: "Reauthorized", pledgeId: c.pledgeId, requestId: c.requestId, authorizationId: newAuthId ? `${c.authorizationId}-R` : c.authorizationId });
      } else if (c.kind === "renewal_request") {
        this.apply(renewalRequestedEvent(c, this.now));
      } else if (c.kind === "expire") {
        this.apply(holdExpiredEvent(c, this.now));
      } else {
        // void is never planned for a hold with accrued shares or a capture in flight
        expect(h.accrued).toBe(0);
        expect(h.capturePending).toBe(0);
        this.apply({ id: this.id("hv"), at: this.now, driveId: "drv1", type: "HoldVoided", pledgeId: c.pledgeId });
      }
    }
  }

  payout(pick: number, ok: boolean) {
    const receipts = [...new Set(this.lines.map((l) => l.line.receiptId))];
    if (receipts.length === 0) return;
    const rid = receipts[pick % receipts.length];
    const vid = this.volunteerOf(rid);
    const s = this.state;
    let cmd;
    try {
      cmd = planPayout(s, rid, vid);
    } catch (e) {
      // refused only for a reason the rules name: a removed volunteer, or their limit
      const v = vid !== undefined ? s.volunteers[vid] : undefined;
      must(v !== undefined && (Boolean(v.removedAt) || v.limitBase !== null), "a payout is refused only for a removed volunteer or a limit", { rid, vid, e: String(e) });
      this.volunteerRefused += 1;
      return;
    }
    if (!cmd) return;
    if (cmd.volunteerId !== undefined && !cmd.retry) this.volunteerPaid += 1;
    if (vid !== undefined && !cmd.retry) {
      const v = s.volunteers[vid];
      must(cmd.volunteerId === vid && !v.removedAt, "a new payout goes to the receipt's invited, active volunteer", { rid, vid });
    }
    const paid = (this.state.payouts[rid] ?? []).filter((a) => a.status === "confirmed").reduce((a, x) => a + x.amount, 0);
    if (!cmd.retry) expect(cmd.amount.minor).toBe(receiptFundedBase(this.state, rid) - paid); // top-ups pay the difference
    if (!cmd.retry) this.apply(payoutSubmittedEvent(cmd, this.now));
    if (ok) this.apply({ id: this.id("po"), at: this.now, driveId: "drv1", type: "PayoutConfirmed", receiptId: rid, senderBatchId: cmd.senderBatchId, payoutBatchId: `PB-${cmd.senderBatchId}` });
    else this.apply({ id: this.id("pf"), at: this.now, driveId: "drv1", type: "PayoutFailed", receiptId: rid, senderBatchId: cmd.senderBatchId, reason: "DENIED" });
  }

  run(op: Op) {
    const s = this.state;
    switch (op.k) {
      case "advance":
        this.now = addMs(this.now, Math.round(op.hours * HOUR_MS));
        return;
      case "capture":
        return this.capture(op.force);
      case "resolve":
        return this.resolve(op.pick, op.ok, op.reason);
      case "reverse":
        return this.reverse(op.pick, op.frac, op.again);
      case "outage":
        return this.outage(op.pick);
      case "maintain":
        return this.maintain(op.newAuthId);
      case "repeatLine": {
        if (this.lines.length === 0) return;
        const { line, ev } = this.lines[op.pick % this.lines.length];
        expect(allocateLine(s, line, this.now)).toBeNull();
        expect(applyEvent(s, { ...ev, id: `dup-${ev.id}` })).toBe(s);
        return;
      }
      case "repeatEvent": {
        const ev = this.events[op.pick % this.events.length];
        expect(applyEvent(s, ev)).toBe(s);
        return;
      }
      case "revoke": {
        const live = s.pledgeIds.filter((id) => isLiveStatus(s.pledges[id].status) && !s.holds[id].revokedAt);
        if (live.length === 0) return;
        this.apply({ id: this.id("rv"), at: this.now, driveId: "drv1", type: "PledgeRevoked", pledgeId: live[op.pick % live.length] });
        return;
      }
      case "authorize": {
        const pending = s.pledgeIds.filter((id) => s.pledges[id].status === "pending_approval" && id !== LATE);
        if (pending.length === 0) return;
        this.authorize(pending[op.pick % pending.length], op.source);
        return;
      }
      case "newPledge": {
        if (s.drive!.status !== "open") return;
        if (op.match && !this.sc.match) return;
        const id = this.id(op.match ? "mx" : "dx");
        this.addPledge(id, op.match ? "match" : "donor", op.match ? null : `n${op.needIdx % this.sc.needs.length}`, this.currency(op.curIdx), op.minor, "paypal", op.minor % 2 === 0);
        return;
      }
      case "payout":
        return this.payout(op.pick, op.ok);
      case "rebind":
        return this.rebind(op.pick, op.needIdx, op.repeat);
      case "renew":
        return this.renew(op.pick, op.approve);
      case "approveRenewal":
        return this.approveRenewal(op.pick, op.deny);
      case "removeVolunteer": {
        if (s.volunteerIds.length === 0) return;
        this.apply({ id: this.id("vr"), at: this.now, driveId: "drv1", type: "VolunteerRemoved", volunteerId: s.volunteerIds[op.pick % s.volunteerIds.length], by: "coordinator" });
        return;
      }
    }
  }

  renewed = 0;

  /** The donor presses "Renew": an independent reading of the rules decides if the book takes it. */
  renew(pick: number, approve: "now" | "later" | "card") {
    const s = this.state;
    const donors = s.pledgeIds.filter((x) => s.pledges[x].kind === "donor");
    if (donors.length === 0) return;
    const id = pick % 7 === 0 ? s.pledgeIds[pick % s.pledgeIds.length] : donors[pick % donors.length];
    const p = s.pledges[id];
    const h = s.holds[id];
    const last = h.renewals?.[h.renewals.length - 1];
    // under way: waiting for approval, or approved and not linked yet (never withdrawn)
    const pending =
      last !== undefined &&
      !s.holds[last].revokedAt &&
      (s.pledges[last].status === "pending_approval" || (isLiveStatus(s.pledges[last].status) && s.holds[last].usable === undefined));
    const may =
      s.drive!.status === "open" &&
      p.kind === "donor" &&
      !h.renewedTo &&
      isLiveStatus(p.status) &&
      !h.revokedAt &&
      !h.blockedAt &&
      Date.parse(this.now) < Date.parse(p.expiresAt!) &&
      !pending &&
      availableMinor(p, h) > 0 &&
      renewalChain(s, id).indexOf(id) < 6; // at most six renewals per chain
    if (!may) {
      expect(() => renewalPledge(s, id, this.now)).toThrow(/renewal_refused/);
      return;
    }
    const pledge = renewalPledge(s, id, this.now);
    expect(pledge).toMatchObject({ renews: id, donorName: p.donorName, needId: p.needId, amount: { currency: p.amount.currency, minor: availableMinor(p, h) }, fx: p.fx });
    this.apply({ id: this.id("pc"), at: this.now, driveId: "drv1", type: "PledgeCreated", pledge: { ...pledge, paypal: { orderId: `ORDER-${pledge.id}` } } });
    // a double click asks for the same pledge id (PayPal replays the same order) and the book refuses a second one
    expect(() => renewalPledge(this.state, id, this.now)).toThrow(/renewal_pending/);
    if (approve !== "later") this.approveRenewalOf(pledge.id, approve === "card" ? "card" : "paypal");
  }

  approveRenewal(pick: number, deny: boolean) {
    const s = this.state;
    const waiting = s.pledgeIds.filter((x) => s.pledges[x].renews !== undefined && s.pledges[x].status === "pending_approval");
    if (waiting.length === 0) return;
    const id = waiting[pick % waiting.length];
    if (deny) this.apply({ id: this.id("pd"), at: this.now, driveId: "drv1", type: "PledgeDenied", pledgeId: id });
    else this.approveRenewalOf(id, "paypal");
  }

  approveRenewalOf(id: string, source: PaymentSource) {
    const oldId = this.state.pledges[id].renews!;
    const oldBefore = this.state.holds[oldId];
    const unpromisedBefore = (oldBefore.usable ?? oldBefore.authorized) - promised(oldBefore);
    this.apply({ id: this.id("pa"), at: this.now, driveId: "drv1", type: "PledgeAuthorized", pledgeId: id, authorizationId: `AUTH-${id}`, paymentSource: source });
    // authorized, not linked: it funds nothing until the link
    must(availableMinor(this.state.pledges[id], this.state.holds[id]) === 0, "an unlinked renewal funds nothing", { id });
    const links = planRenewals(this.state, this.now).filter((e) => e.pledgeId === id);
    if (this.state.holds[oldId].renewedTo || this.state.holds[oldId].revokedAt || this.state.holds[id].revokedAt || !isLiveStatus(this.state.pledges[id].status)) {
      expect(links).toEqual([]);
      // it can never be linked: maintenance lets PayPal release it
      if (isLiveStatus(this.state.pledges[id].status)) {
        expect(planHoldMaintenance(this.state, this.now).filter((c) => c.pledgeId === id).map((c) => c.kind)).toEqual(["void"]);
      }
      return;
    }
    expect(links).toHaveLength(1);
    this.apply(links[0]);
    const nh = this.state.holds[id];
    const carry = Math.min(nh.authorized, Math.max(0, unpromisedBefore));
    must(nh.usable === carry && nh.surplus === nh.authorized - carry, "the renewal carries exactly what the old hold never promised", { id, carry, usable: nh.usable });
    expect(applyEvent(this.state, links[0])).toBe(this.state);
    expect(planRenewals(this.state, this.now).filter((e) => e.pledgeId === id)).toEqual([]);
    this.renewed += 1;
    this.carry();
  }

  /** The donor moves the rest of a hold to another need; an independent reading of the rules decides if it may. */
  rebind(pick: number, needIdx: number, repeat: boolean) {
    const s = this.state;
    // mostly donor holds; sometimes any hold (the match too); with `repeat`, a hold already moved once
    const moved = [...this.rebinds.keys()];
    const pool = repeat && moved.length > 0 ? moved : pick % 5 === 0 ? s.pledgeIds : s.pledgeIds.filter((x) => s.pledges[x].kind === "donor");
    if (pool.length === 0) return;
    const id = pool[pick % pool.length];
    const p = s.pledges[id];
    const h = s.holds[id];
    const to = `n${needIdx % this.sc.needs.length}`;
    const from = p.needId ?? "n0";
    const now = Date.parse(this.now);
    const may =
      s.drive!.status === "open" &&
      p.kind === "donor" &&
      !h.rebound &&
      p.needId !== to &&
      isLiveStatus(p.status) &&
      !h.revokedAt &&
      !h.blockedAt &&
      Boolean(p.expiresAt) &&
      now < Date.parse(p.expiresAt!) - REBIND_BEFORE_EXPIRY_MS &&
      availableMinor(p, h) > 0 &&
      s.qtyCovered[to] < s.needs[to].qtyNeeded;
    const input = { pledgeId: id, fromNeedId: from, toNeedId: to, at: this.now, consent: { by: p.donorName, via: "statement" } };
    if (!may) {
      expect(() => rebindEvent(s, input)).toThrow(/rebind_refused/);
      return;
    }
    const ev = rebindEvent(s, input);
    const before = s;
    this.apply(ev);
    const after = this.state.holds[id];
    // nothing moves at PayPal: the same hold, the same buckets, nothing new to ask PayPal for
    for (const k of ["authorized", "captured", "capturePending", "accrued", "released", "uncollected", "reversed"] as const) must(after[k] === h[k], "a rebind leaves the hold's money as it was", { id, k });
    must(JSON.stringify(after.authorizationIds) === JSON.stringify(h.authorizationIds) && this.state.pledges[id].expiresAt === p.expiresAt, "same authorization, same expiry", { id });
    expect(planHoldMaintenance(this.state, this.now)).toEqual(planHoldMaintenance(before, this.now));
    expect(planCaptures(this.state, this.now, { force: true })).toEqual(planCaptures(before, this.now, { force: true }));
    expect(applyEvent(this.state, ev)).toBe(this.state);
    this.rebinds.set(id, { from, to, at: this.now });
  }

  /** SPEC §6 end to end: confirm what is in flight, capture, void, close. */
  close() {
    if (this.state.drive!.status === "open") this.apply({ id: "closing", at: this.now, driveId: "drv1", type: "DriveClosing" });
    for (let i = 0; i < 20; i++) {
      for (let j = this.pendingBatches().length; j > 0; j--) this.resolve(0, true);
      const cmds = planClose(this.state, this.now);
      if (cmds.some((c) => c.kind === "close_drive")) {
        expect(cmds).toEqual([{ kind: "close_drive", driveId: "drv1" }]);
        this.apply({ id: "closed", at: this.now, driveId: "drv1", type: "DriveClosed" });
        return this.lateApproval();
      }
      for (const c of cmds) {
        if (c.kind === "capture" && !c.retry) {
          expect(this.requestIds.has(c.requestId)).toBe(false);
          this.requestIds.add(c.requestId);
          this.apply(captureSubmittedEvent(c, this.now));
        } else if (c.kind === "void") {
          const h = this.state.holds[c.pledgeId];
          expect([h.accrued, h.capturePending]).toEqual([0, 0]); // void only after the captures are confirmed
          this.apply({ id: this.id("hv"), at: this.now, driveId: "drv1", type: "HoldVoided", pledgeId: c.pledgeId });
        } else if (c.kind === "expire") {
          this.apply(holdExpiredEvent(c, this.now));
        }
      }
      this.now = addMs(this.now, HOUR_MS);
    }
    throw new Error("drive did not close in 20 rounds");
  }

  /** A donor approves after the close: the hold is voided by the planners, not left for 29 days. */
  lateApproval() {
    expect(this.state.pledges[LATE].status).toBe("pending_approval");
    this.authorize(LATE, "paypal");
    expect(unsettledHolds(this.state)).toEqual([LATE]);
    const want = [["void", LATE]];
    expect(planClose(this.state, this.now).map((c) => [c.kind, "pledgeId" in c ? c.pledgeId : ""])).toEqual(want);
    expect(planHoldMaintenance(this.state, this.now).map((c) => [c.kind, c.pledgeId])).toEqual(want);
    this.apply({ id: this.id("hv"), at: this.now, driveId: "drv1", type: "HoldVoided", pledgeId: LATE });
    expect(unsettledHolds(this.state)).toEqual([]);
    expect(planClose(this.state, this.now)).toEqual([]);
  }
}

function runScenario(sc: Scenario): Sim {
  const sim = new Sim(sc);
  sim.open();
  const bySlot = new Map<number, Op[]>();
  for (const { op, slot } of sc.ops) {
    const at = slot % (sc.lines.length + 1);
    bySlot.set(at, [...(bySlot.get(at) ?? []), op]);
  }
  sc.lines.forEach((l, i) => {
    for (const op of bySlot.get(i) ?? []) sim.run(op);
    sim.fund(l);
  });
  for (const op of bySlot.get(sc.lines.length) ?? []) sim.run(op);
  return sim;
}

describe("engine properties (SPEC §3-§6)", () => {
  it("random drives keep every money invariant from first pledge to close", () => {
    let movedRuns = 0;
    let carriedRuns = 0;
    let renewedRuns = 0;
    let volunteerPaidRuns = 0;
    let volunteerRefusedRuns = 0;
    fc.assert(
      fc.property(arbScenario, (sc) => {
        const sim = runScenario(sc);
        if (sim.rebinds.size > 0) movedRuns += 1;
        if (sim.carries > 0) carriedRuns += 1;
        if (sim.renewed > 0) renewedRuns += 1;
        if (sim.volunteerPaid > 0) volunteerPaidRuns += 1;
        if (sim.volunteerRefused > 0) volunteerRefusedRuns += 1;
        sim.close();
        const s = sim.state;
        expect(s.drive!.status).toBe("closed");
        // pledged = spent + released, per hold, in the donor's currency
        for (const row of closeReport(s)) {
          expect(row.settled).toBe(true);
          expect(row.spent + row.released + row.uncollected + row.reversed).toBe(row.pledged);
        }
        for (const id of s.pledgeIds) {
          const h = s.holds[id];
          expect([h.accrued, h.capturePending]).toEqual([0, 0]);
          const st = donorStatement(s, id);
          for (const r of st.rows) expect(["captured", "partly_reversed", "reversed", "uncollected", "nothing_to_capture"]).toContain(r.status);
          expect(st.totals.charged).toBe(h.captured);
          expect(st.totals.uncollected).toBe(h.uncollected);
          expect(st.totals.reversed).toBe(h.reversed);
        }
        // the journal rebuilds the book exactly
        expect(replay(sim.events)).toEqual(s);
      }),
      { numRuns: RUNS },
    );
    // the rebind and carry rules were really exercised, not refused in every run
    expect(movedRuns).toBeGreaterThan(0);
    expect(carriedRuns).toBeGreaterThan(0);
    expect(renewedRuns).toBeGreaterThan(0);
    expect(volunteerPaidRuns).toBeGreaterThan(0);
    expect(volunteerRefusedRuns).toBeGreaterThan(0);
  }, 600_000);

  it("the split does not depend on the order pledges were made in", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ id: fc.stringMatching(/^[a-z]{1,4}$/), minor: fc.integer({ min: 1, max: 5000 }) }), { minLength: 1, maxLength: 12, selector: (p) => p.id }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.boolean(),
        (donors, amount, withMatch) => {
          const build = (order: typeof donors) => {
            let s = applyEvent(emptyLedger(), { id: "o", at: T0, driveId: "drv1", type: "DriveOpened", drive: makeDrive(), needs: [{ id: "w", driveId: "drv1", label: "w", unit: "u", qtyNeeded: 100 }] });
            const all = withMatch ? [...order.map((d) => ({ ...d, match: false })), { id: "zz-match", minor: 3000, match: true }] : order.map((d) => ({ ...d, match: false }));
            for (const d of all) {
              const pledge = makePledge({ id: d.id, kind: d.match ? "match" : "donor", needId: "w", amount: { currency: "JPY", minor: d.minor } });
              s = applyEvent(s, { id: `c-${d.id}`, at: T0, driveId: "drv1", type: "PledgeCreated", pledge });
              s = applyEvent(s, { id: `a-${d.id}`, at: T0, driveId: "drv1", type: "PledgeAuthorized", pledgeId: d.id, authorizationId: `A-${d.id}`, paymentSource: "card" });
            }
            const ev = allocateLine(s, { receiptId: "r", lineNo: 1, needId: "w", needQty: 1, amountBase: amount }, T0) as LineFunded;
            return Object.fromEntries(ev.shares.map((x) => [x.pledgeId, [x.base, x.matchBase]]));
          };
          expect(build([...donors].reverse())).toEqual(build(donors));
        },
      ),
      { numRuns: RUNS },
    );
  });
});
