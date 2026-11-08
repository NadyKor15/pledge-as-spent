import { describe, expect, it } from "vitest";
import type { LineFunded, LineRejected } from "./events";
import { applyEvent, uncommitted } from "./ledger";
import { planCaptures, planClose, planHoldMaintenance } from "./plan";
import { rebindEvent, rebindOffer } from "./rebind";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, T0 } from "./testing/builders";
import { closeReport, donorStatement, pledgeBalance } from "./views";

const CONSENT = { by: "Donor a", via: "statement" };

/** Water 10 bottles, diapers 5 packs, blankets 2; donor a backs water with JPY 3000, the company matches 1:1. */
function story() {
  const b = new Book(makeDrive(), [makeNeed("water", 10), makeNeed("diapers", 5), makeNeed("blankets", 2)]);
  b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 3000 } });
  b.pledge({ id: "c", needId: "diapers", amount: { currency: "JPY", minor: 1000 } });
  b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 100_000 }, ratio: { ratioNum: 1, ratioDen: 1 } });
  return b;
}

const move = (b: Book, at: string, over: Partial<Parameters<typeof rebindEvent>[1]> = {}) =>
  rebindEvent(b.state, { pledgeId: "a", fromNeedId: "water", toNeedId: "diapers", at, consent: CONSENT, ...over });

describe("rebind: the rest of a hold moves to another need", () => {
  it("moves the uncommitted rest, keeps PayPal's authorization untouched, and funds only the new need", () => {
    const b = story();
    // 4 bottles for 1000: donor a pays 500, the match 500
    const first = b.fund(line("r1", 1, "water", 4, 1000), hoursAfter(1)) as LineFunded;
    expect(first.shares.find((s) => s.pledgeId === "a")!.base).toBe(500);
    const before = b.state;
    const balanceBefore = pledgeBalance(before, "a");

    const ev = move(b, hoursAfter(2));
    expect(ev).toMatchObject({ id: "rebind:drv1:a", type: "PledgeRebound", fromNeedId: "water", toNeedId: "diapers", consent: CONSENT });
    b.apply(ev);

    const after = pledgeBalance(b.state, "a");
    expect(after.needId).toBe("diapers");
    // same hold at PayPal: same amount, same authorization, same expiry, same buckets
    for (const k of ["authorized", "captured", "capturePending", "accrued", "released", "uncollected", "available", "authorizationId", "expiresAt"] as const) {
      expect(after[k]).toEqual(balanceBefore[k]);
    }
    expect(after.rebound).toEqual({ at: hoursAfter(2), fromNeedId: "water", toNeedId: "diapers", by: "Donor a", via: "statement" });
    // nothing to ask PayPal for that was not asked before the rebind
    expect(planHoldMaintenance(b.state, hoursAfter(2))).toEqual(planHoldMaintenance(before, hoursAfter(2)));
    expect(planCaptures(b.state, hoursAfter(2), { force: true })).toEqual(planCaptures(before, hoursAfter(2), { force: true }));

    // water gets not a cent from hold a any more
    const water = b.fund(line("r2", 1, "water", 2, 400), hoursAfter(3)) as LineFunded;
    expect(water.shares.some((s) => s.pledgeId === "a")).toBe(false);
    expect(water.unfundedBase).toBe(400);
    // diapers: hold a now backs it next to donor c, and the match follows donor money as before
    const diapers = b.fund(line("r2", 2, "diapers", 1, 600), hoursAfter(3)) as LineFunded;
    const a = diapers.shares.find((s) => s.pledgeId === "a")!;
    const c = diapers.shares.find((s) => s.pledgeId === "c")!;
    expect(a.base + c.base).toBe(300);
    expect(a.base).toBeGreaterThan(c.base); // by capacity: 2500 vs 1000
    expect(diapers.matchBase).toBe(300);
    expect(a.matchBase + c.matchBase).toBe(300);
    // the first line's share stays on water in the statement; the new one is on diapers
    const st = donorStatement(b.state, "a");
    expect(st.rows.map((r) => [r.receiptId, r.needId])).toEqual([
      ["r1", "water"],
      ["r2", "diapers"],
    ]);
  });

  it("gives the new need no more than it lacks: the rest stays with the donor and is released at the close", () => {
    const b = story();
    b.apply(move(b, hoursAfter(1), { toNeedId: "blankets" }));
    // 5 blankets bought, 2 needed: 3 refused as covered
    const ev = b.fund(line("r1", 1, "blankets", 5, 5000), hoursAfter(2)) as LineFunded;
    expect([ev.acceptedQty, ev.rejectedQty, ev.rejectedBase]).toEqual([2, 3, 3000]);
    expect(ev.fundedBase).toBe(2000);
    const a = ev.shares.find((s) => s.pledgeId === "a")!;
    expect(a.base).toBe(1000); // half, the match the other half
    expect(b.fund(line("r1", 2, "blankets", 1, 100), hoursAfter(2))).toMatchObject({ type: "LineRejected", code: "need_covered" });
    // close: captured 1000, the other 2000 of the hold let go
    b.event("DriveClosing", hoursAfter(3), {});
    for (let i = 0; i < 5; i++) {
      for (const c of planClose(b.state, hoursAfter(3))) {
        if (c.kind === "capture") b.submit(c, hoursAfter(3)).confirm(c, hoursAfter(3));
        else if (c.kind === "void") b.event("HoldVoided", hoursAfter(3), { pledgeId: c.pledgeId });
        else if (c.kind === "close_drive") b.event("DriveClosed", hoursAfter(3), {});
      }
    }
    expect(b.state.drive!.status).toBe("closed");
    const row = closeReport(b.state).find((r) => r.pledgeId === "a")!;
    expect(row).toMatchObject({ pledged: 3000, spent: 1000, released: 2000, uncollected: 0, reversed: 0, settled: true });
  });

  it("applies one press once: the same press again is a no-op, a second target is refused", () => {
    const b = story();
    const ev = move(b, hoursAfter(1));
    b.apply(ev);
    const s = b.state;
    expect(applyEvent(s, ev)).toBe(s);
    expect(applyEvent(s, { ...ev, id: "rebind-again" })).toBe(s);
    // a race of two presses for different needs: both events carry the same id, the second is dropped
    const other = rebindEvent(story().state, { pledgeId: "a", fromNeedId: "water", toNeedId: "blankets", at: hoursAfter(1), consent: CONSENT });
    expect(other.id).toBe(ev.id);
    expect(applyEvent(s, other)).toBe(s);
    expect(s.pledges.a.needId).toBe("diapers");
    // the same request under a fresh id is refused by the rule, not silently taken
    expect(() => applyEvent(s, { ...other, id: "x" })).toThrow(/already_rebound/);
    expect(() => move(b, hoursAfter(2), { fromNeedId: "diapers", toNeedId: "blankets" })).toThrow(/already_rebound/);
  });
});

describe("rebind: refusals (red team)", () => {
  const refuses = (b: Book, at: string, code: RegExp, over: Partial<Parameters<typeof rebindEvent>[1]> = {}) => {
    expect(() => move(b, at, over)).toThrow(code);
    // the reducer refuses the same event even when it is written by hand
    const forged = { id: "forged", at, driveId: "drv1", type: "PledgeRebound" as const, pledgeId: "a", fromNeedId: "water", toNeedId: "diapers", consent: CONSENT, ...over };
    expect(() => applyEvent(b.state, forged as never)).toThrow(code);
  };

  it("refuses the company match, an unknown pledge, an unknown need and the same need", () => {
    const b = story();
    refuses(b, hoursAfter(1), /not_donor/, { pledgeId: "m", fromNeedId: "water" });
    refuses(b, hoursAfter(1), /unknown_pledge/, { pledgeId: "nobody" });
    refuses(b, hoursAfter(1), /unknown_need/, { toNeedId: "rice" });
    refuses(b, hoursAfter(1), /same_need/, { toNeedId: "water" });
  });

  it("refuses a hold of another drive and a need of another drive in another currency", () => {
    const other = new Book(makeDrive({ id: "drv2", baseCurrency: "USD" }), [makeNeed("tarps", 3, { driveId: "drv2" })]);
    other.pledge({ id: "x", needId: "tarps", amount: { currency: "USD", minor: 2000 } });
    const b = story();
    refuses(b, hoursAfter(1), /unknown_pledge/, { pledgeId: "x", fromNeedId: "tarps" });
    refuses(b, hoursAfter(1), /unknown_need/, { toNeedId: "tarps" });
    // an event addressed to the other drive does not enter this book
    expect(() => applyEvent(b.state, { id: "x", at: hoursAfter(1), driveId: "drv2", type: "PledgeRebound", pledgeId: "a", fromNeedId: "water", toNeedId: "diapers", consent: CONSENT })).toThrow(/belongs to drive drv2/);
  });

  it("refuses a stale screen and a covered need", () => {
    const b = story();
    refuses(b, hoursAfter(1), /stale_need/, { fromNeedId: "diapers", toNeedId: "blankets" });
    b.fund(line("r1", 1, "diapers", 5, 500), hoursAfter(1));
    refuses(b, hoursAfter(2), /need_covered/);
  });

  it("refuses while closing, after the close, after a void and after a revoke", () => {
    const closing = story();
    closing.event("DriveClosing", hoursAfter(1), {});
    refuses(closing, hoursAfter(2), /drive_not_open/);

    const voided = story();
    voided.event("HoldVoided", hoursAfter(1), { pledgeId: "a" });
    refuses(voided, hoursAfter(2), /hold_not_live/);

    const revoked = story();
    revoked.event("PledgeRevoked", hoursAfter(1), { pledgeId: "a" });
    refuses(revoked, hoursAfter(2), /revoked/);
  });

  it("refuses an unapproved pledge, a blocked hold and a hold with nothing left", () => {
    const pending = new Book(makeDrive(), [makeNeed("water", 10), makeNeed("diapers", 5)]);
    pending.apply({ id: "pc", at: T0, driveId: "drv1", type: "PledgeCreated", pledge: { ...story().state.pledges.a, status: "pending_approval", paypal: { orderId: "O" }, authorizedAt: undefined, expiresAt: undefined, honorUntil: undefined } });
    refuses(pending, hoursAfter(1), /hold_not_live/);

    const blocked = story();
    blocked.fund(line("r1", 1, "water", 1, 200), hoursAfter(1));
    const [cmd] = planCaptures(blocked.state, hoursAfter(1), { force: true }).filter((c) => c.pledgeId === "a");
    blocked.submit(cmd, hoursAfter(1)).failCapture(cmd, hoursAfter(1), "422 INSTRUMENT_DECLINED");
    refuses(blocked, hoursAfter(2), /blocked/);

    const spent = new Book(makeDrive(), [makeNeed("water", 10), makeNeed("diapers", 5)]);
    spent.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    spent.fund(line("r1", 1, "water", 2, 1000), hoursAfter(1));
    expect(uncommitted(spent.state.holds.a)).toBe(0);
    refuses(spent, hoursAfter(2), /nothing_left/);
  });

  it("refuses after expiry and in the last 3 days of the hold's 29", () => {
    const b = story();
    const expiresAt = b.state.pledges.a.expiresAt!;
    expect(expiresAt).toBe(daysAfter(29));
    refuses(b, daysAfter(26), /too_close_to_expiry/);
    refuses(b, daysAfter(27), /too_close_to_expiry/);
    refuses(b, daysAfter(29), /expired/);
    // one millisecond before the window it still moves
    const ok = move(b, new Date(Date.parse(daysAfter(26)) - 1).toISOString());
    expect(ok.type).toBe("PledgeRebound");
  });

  it("needs the donor's consent on the event", () => {
    const b = story();
    const ev = move(b, hoursAfter(1));
    expect(() => applyEvent(b.state, { ...ev, consent: { by: "", via: "statement" } })).toThrow(/consent/);
    expect(() => applyEvent(b.state, { ...ev, consent: undefined } as never)).toThrow(/consent/);
  });
});

describe("rebind offer on the statement", () => {
  it("lists the open needs and what would move", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 4, 1000), hoursAfter(1));
    const offer = rebindOffer(b.state, "a", hoursAfter(2));
    expect(offer).toMatchObject({ pledgeId: "a", needId: "water", available: { currency: "JPY", minor: 2500 }, availableBase: 2500, refusal: null, rebound: null });
    expect(offer.targets.map((t) => [t.needId, t.remainingQty])).toEqual([
      ["diapers", 5],
      ["blankets", 2],
    ]);
  });

  it("drops covered needs and says why nothing is offered", () => {
    const b = story();
    b.fund(line("r1", 1, "diapers", 5, 500), hoursAfter(1));
    expect(rebindOffer(b.state, "a", hoursAfter(2)).targets.map((t) => t.needId)).toEqual(["blankets"]);
    expect(rebindOffer(b.state, "a", daysAfter(27))).toMatchObject({ targets: [], refusal: { code: "too_close_to_expiry" } });
    b.apply(move(b, hoursAfter(2), { toNeedId: "blankets" }));
    expect(rebindOffer(b.state, "a", hoursAfter(3))).toMatchObject({ needId: "blankets", targets: [], refusal: { code: "already_rebound" }, rebound: { toNeedId: "blankets" } });
    expect(rebindOffer(b.state, "m", hoursAfter(3))).toMatchObject({ targets: [], refusal: { code: "not_donor" } });
  });

  it("a rejected line is never moved: refused lines stay where they were", () => {
    const b = story();
    const r = b.fund(line("r1", 1, "water", 20, 1000), hoursAfter(1)) as LineFunded | LineRejected;
    expect(r.type).toBe("LineFunded");
    b.apply(move(b, hoursAfter(2)));
    expect(b.state.lines["r1:1"].event).toBe(r);
  });
});
