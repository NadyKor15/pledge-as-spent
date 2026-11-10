import { describe, expect, it } from "vitest";
import type { LineFunded, PledgeRenewed } from "./events";
import { applyEvent, availableMinor, uncommitted } from "./ledger";
import { planCaptures, planClose, planExplicitReauthorize, planHoldMaintenance } from "./plan";
import { rebindEvent } from "./rebind";
import { chainStatement, planRenewals, renewalOffer, renewalPledge } from "./renew";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, T0 } from "./testing/builders";
import { closeReport, donorStatement, pledgeBalance } from "./views";

// A hold lives 29 days; a reauthorize keeps the same expiry. To go on past it,
// the donor approves a NEW order for what the old hold has not promised yet.
// The book links the two: the old one stops funding, captures what it owes and
// is voided; the new one may promise at most what the old one still had at the
// moment of the approval. Across the chain nobody is charged more than pledged.

/** Water 40, diapers 6 (JPY drive); Lena EUR 20.00 on water at 162.35; the company matches 1:1. */
function story() {
  const b = new Book(makeDrive(), [makeNeed("water", 40), makeNeed("diapers", 6)]);
  b.pledge({ id: "lena", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35" });
  b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 500_000 }, ratio: { ratioNum: 1, ratioDen: 1 } });
  return b;
}

/** The donor presses "Renew" at `at`; with `approveAt` the new order is approved then, and the book links the two holds. */
function renew(b: Book, oldId: string, at: string, approveAt?: string, source: "paypal" | "card" = "paypal") {
  const pledge = renewalPledge(b.state, oldId, at);
  b.apply({ id: `pledge:${pledge.id}`, at, driveId: "drv1", type: "PledgeCreated", pledge: { ...pledge, paypal: { orderId: `ORDER-${pledge.id}` } } });
  if (approveAt) {
    b.authorize(pledge.id, approveAt, source);
    for (const e of planRenewals(b.state, approveAt)) b.apply(e);
  }
  return pledge.id;
}

/** Captures and voids until the planners have nothing left for these holds. */
function settle(b: Book, at: string) {
  for (let i = 0; i < 5; i++) {
    for (const c of b.state.drive!.status === "open" ? [...planCaptures(b.state, at), ...planHoldMaintenance(b.state, at)] : planClose(b.state, at)) {
      if (c.kind === "capture" && !c.retry) b.submit(c, at).confirm(c, at);
      else if (c.kind === "void") b.event("HoldVoided", at, { pledgeId: c.pledgeId });
      else if (c.kind === "expire") b.event("HoldExpired", at, { pledgeId: c.pledgeId });
      else if (c.kind === "close_drive") b.event("DriveClosed", at, {});
    }
  }
}

describe("renew: a new order for the rest, approved again by the donor", () => {
  it("links the two holds: the old one captures what it owes and is voided, the new one funds from then on", () => {
    const b = story();
    const w1 = b.fund(line("r1", 1, "water", 10, 1080), hoursAfter(1)) as LineFunded; // Lena ¥540 = €3.33
    const lenaShare = w1.shares.find((s) => s.pledgeId === "lena")!;
    expect(lenaShare.quote).toEqual({ currency: "EUR", minor: 333 });
    const rest = availableMinor(b.state.pledges.lena, b.state.holds.lena);
    expect(rest).toBe(2000 - 333);

    // day 27: inside the last 3 days the statement reminds; the donor renews
    const offer = renewalOffer(b.state, "lena", daysAfter(27));
    expect(offer).toMatchObject({ pledgeId: "lena", remind: true, available: { currency: "EUR", minor: rest }, refusal: null, pending: null, renewedTo: null });
    expect(offer.remindFrom).toBe(daysAfter(26));
    expect(renewalOffer(b.state, "lena", daysAfter(2))).toMatchObject({ remind: false, refusal: null }); // the button is there from day 0

    const next = renew(b, "lena", daysAfter(27), daysAfter(27));
    expect(next).toBe("lena.r1");
    const p = b.state.pledges[next];
    expect(p).toMatchObject({ kind: "donor", needId: "water", donorName: "Donor lena", renews: "lena", amount: { currency: "EUR", minor: rest }, fx: b.state.pledges.lena.fx, status: "authorized" });
    expect(p.expiresAt).toBe(daysAfter(27 + 29));

    // the old hold: funds nothing new, its accrued share is captured, then it is voided
    expect(availableMinor(b.state.pledges.lena, b.state.holds.lena)).toBe(0);
    expect(b.state.holds.lena.renewedTo).toBe(next);
    const caps = planCaptures(b.state, daysAfter(27)).filter((c) => c.pledgeId === "lena");
    expect(caps).toHaveLength(1);
    expect(caps[0].reasons).toContain("renewed");
    expect(planHoldMaintenance(b.state, daysAfter(27)).filter((c) => c.pledgeId === "lena")).toEqual([]); // not before the capture is confirmed
    settle(b, daysAfter(27));
    expect(b.state.pledges.lena.status).toBe("voided");
    expect(pledgeBalance(b.state, "lena")).toMatchObject({ captured: 333, released: rest, renewedTo: next });

    // the new hold carries the whole rest: it may promise exactly that
    expect(b.state.holds[next]).toMatchObject({ usable: rest, surplus: 0 });
    const w2 = b.fund(line("r2", 1, "water", 30, 3240), daysAfter(28)) as LineFunded;
    expect(w2.shares.map((s) => s.pledgeId).sort()).toEqual(["lena.r1", "m"]);
    expect(w2.shares.some((s) => s.pledgeId === "lena")).toBe(false);
    const st = donorStatement(b.state, next);
    expect(st.balance.renews).toBe("lena");
  });

  it("never lets the chain promise more than the donor pledged: lines funded between the press and the approval trim the new hold", () => {
    const b = story();
    const next = renew(b, "lena", hoursAfter(1)); // asks for the whole €20.00, approval still to come
    expect(b.state.pledges[next].amount.minor).toBe(2000);
    expect(renewalOffer(b.state, "lena", hoursAfter(1))).toMatchObject({ refusal: null, pending: { pledgeId: next, approved: false, amount: { currency: "EUR", minor: 2000 } } });
    // the old hold keeps funding while the donor is in the PayPal window
    const w = b.fund(line("r1", 1, "water", 10, 1080), hoursAfter(2)) as LineFunded;
    const used = w.shares.find((s) => s.pledgeId === "lena")!.quote.minor;
    b.authorize(next, hoursAfter(3));
    // authorized but not linked yet: it funds nothing (no double capacity)
    expect(availableMinor(b.state.pledges[next], b.state.holds[next])).toBe(0);
    const [linked] = planRenewals(b.state, hoursAfter(3));
    expect(linked).toMatchObject({ id: `renewed:drv1:${next}`, type: "PledgeRenewed", pledgeId: next, fromPledgeId: "lena" });
    b.apply(linked);
    expect(b.state.holds[next]).toMatchObject({ authorized: 2000, usable: 2000 - used, surplus: used });
    expect(availableMinor(b.state.pledges[next], b.state.holds[next])).toBe(2000 - used);
    expect(uncommitted(b.state.holds[next])).toBe(2000 - used);

    // spend everything: the chain never charges more than €20.00 in all
    b.fund(line("r2", 1, "water", 30, 100_000), hoursAfter(4));
    b.event("DriveClosing", hoursAfter(5), {});
    settle(b, hoursAfter(5));
    expect(b.state.drive!.status).toBe("closed");
    const rows = closeReport(b.state).filter((r) => r.pledgeId === "lena" || r.pledgeId === next);
    for (const r of rows) expect(r.settled).toBe(true);
    expect(rows.reduce((a, r) => a + r.spent, 0)).toBe(2000);
    // the trimmed part was held at PayPal and let go at the close, never charged
    expect(rows.find((r) => r.pledgeId === next)!.released).toBe(used);
  });

  it("renews a card hold too (a new order; only a reauthorize needs a PayPal account), and keeps the donor's rest choice and one manual move per chain", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 40), makeNeed("diapers", 6)]);
    b.pledge({ id: "card", needId: "water", amount: { currency: "JPY", minor: 3000 }, rest: "carry" }, T0, "card");
    b.apply(rebindEvent(b.state, { pledgeId: "card", fromNeedId: "water", toNeedId: "diapers", at: hoursAfter(1), consent: { by: "Donor card", via: "statement" } }));
    const next = renew(b, "card", hoursAfter(2), hoursAfter(2), "card");
    expect(b.state.pledges[next]).toMatchObject({ needId: "diapers", rest: "carry", paymentSource: "card" });
    expect(() => rebindEvent(b.state, { pledgeId: next, fromNeedId: "diapers", toNeedId: "water", at: hoursAfter(3), consent: { by: "Donor card", via: "statement" } })).toThrow(/already_rebound/);
  });

  it("renews holds in euros, dollars and yen, each for its own rest in its own currency", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 40)]);
    b.pledge({ id: "eur", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35" });
    b.pledge({ id: "usd", needId: "water", amount: { currency: "USD", minor: 3000 }, rate: "151.20" });
    b.pledge({ id: "jpy", needId: "water", amount: { currency: "JPY", minor: 3000 } });
    b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    for (const id of ["eur", "usd", "jpy"]) {
      const rest = availableMinor(b.state.pledges[id], b.state.holds[id]);
      const next = renew(b, id, daysAfter(27), daysAfter(27));
      expect(b.state.pledges[next].amount).toEqual({ currency: b.state.pledges[id].amount.currency, minor: rest });
      expect(b.state.holds[next].usable).toBe(rest);
    }
    settle(b, daysAfter(27));
    for (const id of ["eur", "usd", "jpy"]) {
      const old = b.state.holds[id];
      const nw = b.state.holds[`${id}.r1`];
      expect(b.state.pledges[id].status).toBe("voided");
      expect(old.captured + nw.authorized).toBe(b.state.pledges[id].amount.minor); // spent + carried = pledged
    }
  });
});

describe("renew: findings of the money review, 10.11", () => {
  it("#1 refuses a second renewal while the first is approved but not linked, and links one per old hold", () => {
    const b = story();
    const r1 = renew(b, "lena", hoursAfter(1));
    b.authorize(r1, hoursAfter(2)); // approved; the link is still to come (a crash between the two)
    expect(renewalOffer(b.state, "lena", hoursAfter(2)).pending).toMatchObject({ pledgeId: r1, approved: true });
    expect(() => renewalPledge(b.state, "lena", hoursAfter(2))).toThrow(/renewal_pending/);
    // a second renewal written by hand is refused by the book too
    const forged = { ...renewalPledge(story().state, "lena", hoursAfter(2)), id: "lena.r2", paypal: { orderId: "O2" } };
    expect(() => applyEvent(b.state, { id: "pc-r2", at: hoursAfter(2), driveId: "drv1", type: "PledgeCreated", pledge: forged })).toThrow(/renewal_pending/);
    expect(planRenewals(b.state, hoursAfter(2)).map((e) => e.pledgeId)).toEqual([r1]);
    // the planner holds to "one link per old hold" on its own, even given a book with two approved renewals of one
    // hold (the book refuses to make one; this is the planner's own guard, e.g. for a journal from before that check)
    const s = b.state;
    const twin = { ...s.pledges[r1], id: "lena.twin" };
    const two = { ...s, pledgeIds: [...s.pledgeIds, twin.id], pledges: { ...s.pledges, [twin.id]: twin }, holds: { ...s.holds, [twin.id]: { ...s.holds[r1], pledgeId: twin.id } } };
    expect(planRenewals(two, hoursAfter(2)).map((e) => [e.pledgeId, e.fromPledgeId])).toEqual([[r1, "lena"]]);
  });

  it("#1 voids an approved renewal that can no longer be linked: its old hold was renewed by another, or withdrawn", () => {
    const b = story();
    const r1 = renew(b, "lena", hoursAfter(1));
    b.event("PledgeRevoked", hoursAfter(2), { pledgeId: "lena" });
    b.authorize(r1, hoursAfter(3));
    expect(planRenewals(b.state, hoursAfter(3))).toEqual([]); // nothing to carry on from a withdrawn hold
    const voids = planHoldMaintenance(b.state, hoursAfter(3)).filter((c) => c.pledgeId === r1);
    expect(voids).toMatchObject([{ kind: "void", reason: "renewal_unlinked" }]);
  });

  it("#2 voids a linked renewal with nothing left to fund at once, and never reauthorizes it", () => {
    const b = story();
    const r1 = renew(b, "lena", hoursAfter(1)); // all €20.00
    b.fund(line("r1", 1, "water", 40, 1_000_000), hoursAfter(2)); // the old hold is used up meanwhile
    b.authorize(r1, hoursAfter(3));
    for (const e of planRenewals(b.state, hoursAfter(3))) b.apply(e);
    expect(b.state.holds[r1]).toMatchObject({ usable: 0, surplus: 2000 });
    expect(planHoldMaintenance(b.state, hoursAfter(3)).filter((c) => c.pledgeId === r1)).toMatchObject([{ kind: "void", reason: "renewed" }]);
    // nor by hand on day 4, when a reauthorize would open: it would only keep the surplus held longer
    expect(() => planExplicitReauthorize(b.state, r1, daysAfter(5))).toThrow(/nothing on this hold can still be charged/);
    // a renewal whose usable part is all promised: once its captures are in, its surplus is let go, not reauthorized
    const c = story();
    const r = renew(c, "lena", hoursAfter(1));
    c.fund(line("r1", 1, "water", 10, 1080), hoursAfter(2)); // the old hold pays €3.33 meanwhile: surplus 333
    c.authorize(r, hoursAfter(3));
    for (const e of planRenewals(c.state, hoursAfter(3))) c.apply(e);
    c.fund(line("r2", 1, "water", 30, 1_000_000), hoursAfter(4)); // uses up the usable part
    expect(availableMinor(c.state.pledges[r], c.state.holds[r])).toBe(0);
    settle(c, daysAfter(5));
    expect(c.state.pledges[r].status).toBe("voided");
    expect(c.state.holds[r]).toMatchObject({ captured: 1667, released: 333 });
  });

  it("#3 refuses a link for a withdrawn renewal, or from a withdrawn hold", () => {
    const b = story();
    const r1 = renew(b, "lena", hoursAfter(1));
    b.event("PledgeRevoked", hoursAfter(2), { pledgeId: r1 });
    b.authorize(r1, hoursAfter(3));
    const link: PledgeRenewed = { id: "forged", at: hoursAfter(3), driveId: "drv1", type: "PledgeRenewed", pledgeId: r1, fromPledgeId: "lena" };
    expect(() => applyEvent(b.state, link)).toThrow(/withdrawn/);
    const c = story();
    const r2 = renew(c, "lena", hoursAfter(1));
    c.event("PledgeRevoked", hoursAfter(2), { pledgeId: "lena" });
    c.authorize(r2, hoursAfter(3));
    expect(() => applyEvent(c.state, { ...link, pledgeId: r2 })).toThrow(/withdrawn/);
  });

  it("#4 takes a renewal whose old hold moved to another need meanwhile, and links it to that need", () => {
    const b = story();
    const pledge = renewalPledge(b.state, "lena", hoursAfter(1)); // computed for water
    b.apply(rebindEvent(b.state, { pledgeId: "lena", fromNeedId: "water", toNeedId: "diapers", at: hoursAfter(1), consent: { by: "Donor lena", via: "statement" } }));
    b.apply({ id: "pc", at: hoursAfter(1), driveId: "drv1", type: "PledgeCreated", pledge: { ...pledge, paypal: { orderId: "O" } } });
    b.authorize(pledge.id, hoursAfter(2));
    for (const e of planRenewals(b.state, hoursAfter(2))) b.apply(e);
    expect(b.state.pledges[pledge.id].needId).toBe("diapers");
  });

  it("caps a chain at six renewals (a new pledge starts a new hold)", () => {
    const b = story();
    let id = "lena";
    for (let i = 0; i < 6; i++) id = renew(b, id, hoursAfter(1 + i), hoursAfter(1 + i));
    expect(id.split(".r")).toHaveLength(7);
    expect(() => renewalPledge(b.state, id, hoursAfter(8))).toThrow(/too_many_renewals/);
  });

  it("tells one history for the whole chain, the same from either hold", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 10, 1080), hoursAfter(1)); // Lena €3.33
    expect(chainStatement(b.state, "lena")).toBeNull(); // never renewed
    const r1 = renew(b, "lena", daysAfter(27), daysAfter(27));
    settle(b, daysAfter(27));
    b.fund(line("r2", 1, "water", 10, 1080), daysAfter(28)); // €3.33 from the renewal
    const c = chainStatement(b.state, "lena")!;
    expect(chainStatement(b.state, r1)).toEqual(c);
    expect(c).toMatchObject({ first: "lena", latest: r1, currency: "EUR" });
    expect(c.members.map((m) => [m.pledgeId, m.status, m.authorized, m.usable, m.captured, m.released])).toEqual([
      ["lena", "voided", 2000, null, 333, 1667],
      [r1, "authorized", 1667, 1667, 0, 0],
    ]);
    expect(c.events.map((e) => [e.kind, e.pledgeId])).toEqual([
      ["pledged", "lena"],
      ["renewed", r1],
      ["ended", "lena"],
    ]);
    expect(c.rows.map((r) => [r.receiptId, r.pledgeId])).toEqual([
      ["r1", "lena"],
      ["r2", r1],
    ]);
    // one pledge of €20.00: €3.33 charged, €3.33 waiting for capture, €13.34 the renewal can still pay, nothing released yet
    expect(c.totals).toEqual({ pledged: 2000, charged: 333, waiting: 333, held: 1334, returning: 0, never: 0, back: 0, uncollected: 0 });
    expect(c.totals.charged + c.totals.waiting + c.totals.held + c.totals.never + c.totals.back + c.totals.returning).toBe(c.totals.pledged);
  });

  it("#5 the close report names each hold's chain, so a chain can be counted once", () => {
    const b = story();
    const r1 = renew(b, "lena", daysAfter(27), daysAfter(27));
    settle(b, daysAfter(27));
    const rows = closeReport(b.state);
    expect(rows.find((r) => r.pledgeId === "lena")).toMatchObject({ renewedTo: r1 });
    expect(rows.find((r) => r.pledgeId === r1)).toMatchObject({ renews: "lena" });
  });
});

describe("renew: refusals and repeats (red team)", () => {
  const refused = (b: Book, id: string, at: string, code: RegExp) => expect(() => renewalPledge(b.state, id, at)).toThrow(code);

  it("refuses the match, a withdrawn hold, an expired one, a closing drive and a hold with nothing left", () => {
    const b = story();
    refused(b, "m", hoursAfter(1), /not_donor/);
    refused(b, "ghost", hoursAfter(1), /unknown_pledge/);
    expect(renewalOffer(b.state, "lena", daysAfter(29)).refusal).toMatchObject({ code: "expired" });
    refused(b, "lena", daysAfter(29), /expired/);
    const revoked = story();
    revoked.event("PledgeRevoked", hoursAfter(1), { pledgeId: "lena" });
    refused(revoked, "lena", hoursAfter(2), /revoked/);
    const spent = story();
    spent.fund(line("r1", 1, "water", 40, 1_000_000), hoursAfter(1));
    expect(availableMinor(spent.state.pledges.lena, spent.state.holds.lena)).toBe(0);
    refused(spent, "lena", hoursAfter(2), /nothing_left/);
    const closing = story();
    closing.event("DriveClosing", hoursAfter(1), {});
    refused(closing, "lena", hoursAfter(1), /drive_not_open/);
  });

  it("allows one renewal at a time and one per hold: a second press waits for the first, a renewed hold renews no more", () => {
    const b = story();
    const next = renew(b, "lena", hoursAfter(1));
    refused(b, "lena", hoursAfter(1), /renewal_pending/);
    // the same PledgeCreated again is a no-op; a second renewal pledge for the same hold is refused by the book
    const again = renewalPledge(story().state, "lena", hoursAfter(1));
    expect(again.id).toBe(next); // a double click derives the same id: PayPal replays the same order
    const forged = { ...again, id: "lena.rX", paypal: { orderId: "O" } };
    expect(() => applyEvent(b.state, { id: "pc-x", at: hoursAfter(1), driveId: "drv1", type: "PledgeCreated", pledge: forged })).toThrow(/renewal_pending/);
    b.authorize(next, hoursAfter(2));
    const linked = planRenewals(b.state, hoursAfter(2));
    for (const e of linked) b.apply(e);
    expect(planRenewals(b.state, hoursAfter(2))).toEqual([]); // linked once
    expect(applyEvent(b.state, linked[0])).toBe(b.state);
    expect(() => applyEvent(b.state, { ...linked[0], id: "renewed-again" })).toThrow(/already renewed/);
    refused(b, "lena", hoursAfter(3), /renewed/);
  });

  it("lets a declined renewal go: the old hold keeps funding and the next press takes a new id", () => {
    const b = story();
    const first = renew(b, "lena", hoursAfter(1));
    b.event("PledgeDenied", hoursAfter(2), { pledgeId: first });
    expect(availableMinor(b.state.pledges.lena, b.state.holds.lena)).toBe(2000);
    expect(renewalOffer(b.state, "lena", hoursAfter(2)).pending).toBeNull();
    expect(renew(b, "lena", hoursAfter(3))).toBe("lena.r2");
  });

  it("refuses a renewal pledge written by hand that differs from the old hold", () => {
    const b = story();
    const ok = renewalPledge(b.state, "lena", hoursAfter(1));
    const tries: [Partial<typeof ok>, RegExp][] = [
      [{ amount: { currency: "EUR", minor: 2001 } }, /more than/],
      [{ amount: { currency: "USD", minor: 100 } }, /currency/],
      [{ donorName: "Someone else" }, /donor/],
      [{ fx: { ...ok.fx, rate: "170" } }, /rate/],
      [{ rest: "carry" }, /rest/],
      [{ kind: "match", needId: null, match: { ratioNum: 1, ratioDen: 1 } }, /donor/],
      [{ renews: "m" }, /not_donor/],
    ];
    for (const [over, code] of tries) {
      const pledge = { ...ok, ...over, paypal: { orderId: "O" } };
      expect(() => applyEvent(b.state, { id: "pc-forged", at: hoursAfter(1), driveId: "drv1", type: "PledgeCreated", pledge })).toThrow(code);
    }
  });

  it("refuses a link the book did not ask for: a hold that is no renewal, not yet approved, or of another hold", () => {
    const b = story();
    const next = renew(b, "lena", hoursAfter(1));
    const link = (over: Partial<PledgeRenewed>): PledgeRenewed => ({ id: "forged", at: hoursAfter(2), driveId: "drv1", type: "PledgeRenewed", pledgeId: next, fromPledgeId: "lena", ...over });
    expect(() => applyEvent(b.state, link({}))).toThrow(/not approved/);
    b.authorize(next, hoursAfter(2));
    expect(() => applyEvent(b.state, link({ fromPledgeId: "m" }))).toThrow(/renews lena/);
    expect(() => applyEvent(b.state, link({ pledgeId: "m", fromPledgeId: "lena" }))).toThrow(/renews/);
  });
});
