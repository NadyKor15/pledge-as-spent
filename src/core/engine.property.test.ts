import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateLine } from "./allocate";
import type { LedgerEvent, LineFunded } from "./events";
import {
  applyEvent,
  availableMinor,
  capacityBase,
  emptyLedger,
  isFundable,
  isLiveStatus,
  type LedgerState,
  matchRatio,
  receiptFundedBase,
  replay,
  uncommitted,
} from "./ledger";
import { minorRate } from "./money";
import {
  captureSubmittedEvent,
  holdExpiredEvent,
  payoutSubmittedEvent,
  planCaptures,
  planClose,
  planHoldMaintenance,
  planPayout,
  renewalRequestedEvent,
} from "./plan";
import { arbRate, CURRENCIES, RUNS } from "./testing/arbitraries";
import { makeDrive, makePledge } from "./testing/builders";
import { addMs, HOUR_MS } from "./time";
import type { CurrencyCode, FundableLineInput, Need, PaymentSource, Pledge } from "./types";
import { closeReport, donorStatement } from "./views";

// ---- scenario generators ----------------------------------------------------

type Approval = PaymentSource | "pending" | "denied";

type Op =
  | { k: "advance"; hours: number }
  | { k: "capture"; force: boolean }
  | { k: "resolve"; pick: number; ok: boolean }
  | { k: "maintain"; newAuthId: boolean }
  | { k: "repeatLine"; pick: number }
  | { k: "repeatEvent"; pick: number }
  | { k: "revoke"; pick: number }
  | { k: "authorize"; pick: number; source: PaymentSource }
  | { k: "newPledge"; needIdx: number; curIdx: number; minor: number; match: boolean }
  | { k: "payout"; pick: number; ok: boolean };

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
  { weight: 4, arbitrary: fc.record({ k: fc.constant("resolve" as const), pick: fc.nat(), ok: fc.boolean() }) },
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
  { weight: 1, arbitrary: fc.record({ k: fc.constant("payout" as const), pick: fc.nat(), ok: fc.boolean() }) },
);

const arbScenario = fc.record({
  base: fc.constantFrom(...CURRENCIES),
  currencies: fc.uniqueArray(fc.constantFrom(...CURRENCIES), { minLength: 1, maxLength: 6 }),
  rates: fc.array(arbRate(), { minLength: 6, maxLength: 6 }),
  needs: fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 8 }),
  holds: fc.array(
    fc.record({ needIdx: fc.nat(), curIdx: fc.nat(), minor: fc.integer({ min: 1, max: 300_000 }), approval: arbApproval }),
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
    fc.record({ needIdx: fc.nat(), qty: fc.integer({ min: 1, max: 25 }), amount: fc.integer({ min: 0, max: 100_000 }), receipt: fc.integer({ min: 0, max: 7 }) }),
    { minLength: 1, maxLength: 60, size: "max" },
  ),
  ops: fc.array(fc.record({ op: arbOp, slot: fc.nat() }), { maxLength: 60, size: "max" }),
  threshold: fc.option(fc.integer({ min: 1, max: 50_000 }), { nil: null }),
  maxAgeHours: fc.integer({ min: 1, max: 72 }),
});

type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

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
    must(uncommitted(h) >= 0, "captured + pending + accrued + released <= authorized", ctx);
    must(h.uncollected <= h.released, "uncollected is part of released", ctx);
    must(h.accrued === h.accruals.reduce((a, x) => a + x.minor, 0), "accrued = sum of accruals", ctx);
    let pending = 0;
    let pendingCount = 0;
    let confirmed = 0;
    for (const b of h.batches) {
      if (b.status === "pending") {
        pending += b.amount;
        pendingCount += 1;
      } else if (b.status === "confirmed") confirmed += b.amount;
    }
    must(h.capturePending === pending, "capturePending = pending batches", ctx);
    must(h.captured === confirmed, "captured = confirmed batches", ctx);
    must(pendingCount <= 1, "one capture in flight per hold", ctx);
    must(availableMinor(p, h) <= uncommitted(h), "available <= uncommitted", ctx);
    if (p.status === "voided" || p.status === "expired") {
      must(h.accrued === 0 && uncommitted(h) === 0, "an ended hold keeps nothing", ctx);
    }
    if (p.status === "captured") must(h.captured === h.authorized, "captured status means fully captured", ctx);
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

  addPledge(id: string, kind: "donor" | "match", needId: string | null, c: CurrencyCode, minor: number, approval: Approval) {
    const ratio = this.sc.match ? { ratioNum: this.sc.match.ratioNum, ratioDen: this.sc.match.ratioDen } : undefined;
    const pledge: Pledge = makePledge({ id, kind, needId, amount: { currency: c, minor }, rate: this.rate(c), ratio, baseCurrency: this.sc.base });
    this.apply({ id: this.id("pc"), at: this.now, driveId: "drv1", type: "PledgeCreated", pledge });
    if (approval === "denied") this.apply({ id: this.id("pd"), at: this.now, driveId: "drv1", type: "PledgeDenied", pledgeId: id });
    else if (approval !== "pending") this.authorize(id, approval);
  }

  authorize(pledgeId: string, source: PaymentSource) {
    this.apply({ id: this.id("pa"), at: this.now, driveId: "drv1", type: "PledgeAuthorized", pledgeId, authorizationId: `AUTH-${pledgeId}`, paymentSource: source });
  }

  open() {
    const sc = this.sc;
    const needs: Need[] = sc.needs.map((q, i) => ({ id: `n${i}`, driveId: "drv1", label: `need ${i}`, unit: "unit", qtyNeeded: q }));
    const drive = makeDrive({
      baseCurrency: sc.base,
      batch: { maxAgeHours: sc.maxAgeHours, thresholdMinor: sc.threshold ? { [sc.base]: sc.threshold } : {} },
    });
    this.apply({ id: "open", at: T0, driveId: "drv1", type: "DriveOpened", drive, needs });
    sc.holds.forEach((h, i) => this.addPledge(`d${String(i).padStart(2, "0")}`, "donor", `n${h.needIdx % needs.length}`, this.currency(h.curIdx), h.minor, h.approval));
    if (sc.match) {
      for (let j = 0; j < sc.match.count; j++) this.addPledge(`m${j}`, "match", null, this.currency(sc.match.curIdx + j), sc.match.minor, "paypal");
    }
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
    this.apply(ev);
    this.lines.push({ line, ev });
  }

  capture(force: boolean) {
    for (const c of planCaptures(this.state, this.now, { force })) {
      const h = this.state.holds[c.pledgeId];
      if (c.retry) {
        expect(h.batches.find((b) => b.status === "pending")!.requestId).toBe(c.requestId);
        continue;
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

  resolve(pick: number, ok: boolean) {
    const pending = this.pendingBatches();
    if (pending.length === 0) return;
    const { pledgeId, b } = pending[pick % pending.length];
    if (ok) {
      const currency = this.state.pledges[pledgeId].amount.currency;
      this.apply({ id: this.id("cc"), at: this.now, driveId: "drv1", type: "CaptureConfirmed", pledgeId, requestId: b.requestId, captureId: `CAP-${b.requestId}`, amount: { currency, minor: b.amount } });
    } else {
      this.apply({ id: this.id("cf"), at: this.now, driveId: "drv1", type: "CaptureFailed", pledgeId, requestId: b.requestId, reason: "DECLINED" });
    }
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
    const cmd = planPayout(this.state, rid);
    if (!cmd) return;
    expect(cmd.amount.minor).toBe(receiptFundedBase(this.state, rid));
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
        return this.resolve(op.pick, op.ok);
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
        const pending = s.pledgeIds.filter((id) => s.pledges[id].status === "pending_approval");
        if (pending.length === 0) return;
        this.authorize(pending[op.pick % pending.length], op.source);
        return;
      }
      case "newPledge": {
        if (s.drive!.status !== "open") return;
        if (op.match && !this.sc.match) return;
        const id = this.id(op.match ? "mx" : "dx");
        this.addPledge(id, op.match ? "match" : "donor", op.match ? null : `n${op.needIdx % this.sc.needs.length}`, this.currency(op.curIdx), op.minor, "paypal");
        return;
      }
      case "payout":
        return this.payout(op.pick, op.ok);
    }
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
        return;
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
    fc.assert(
      fc.property(arbScenario, (sc) => {
        const sim = runScenario(sc);
        sim.close();
        const s = sim.state;
        expect(s.drive!.status).toBe("closed");
        // pledged = spent + released, per hold, in the donor's currency
        for (const row of closeReport(s)) {
          expect(row.settled).toBe(true);
          expect(row.spent + row.released).toBe(row.pledged);
        }
        for (const id of s.pledgeIds) {
          const h = s.holds[id];
          expect([h.accrued, h.capturePending]).toEqual([0, 0]);
          for (const r of donorStatement(s, id).rows) expect(["captured", "uncollected", "nothing_to_capture"]).toContain(r.status);
        }
        // the journal rebuilds the book exactly
        expect(replay(sim.events)).toEqual(s);
      }),
      { numRuns: RUNS },
    );
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
