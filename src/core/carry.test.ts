import { describe, expect, it } from "vitest";
import { carryTarget, planCarries } from "./carry";
import type { LineFunded, RestCarried } from "./events";
import { applyEvent, uncommitted } from "./ledger";
import { planCaptures, planClose, planHoldMaintenance } from "./plan";
import { rebindEvent } from "./rebind";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, makePledge, T0 } from "./testing/builders";
import { closeReport, pledgeBalance } from "./views";

// The donor chose at the pledge: "keep the rest for this drive's next purchases".
// When the need their hold backs is covered, the rest moves by itself to the
// open need that lacks the most (ties: the drive's order). PayPal is not called.

/** Water 10, diapers 5, blankets 2 (JPY drive); donor a backs water with JPY 3000 and keeps the rest; c backs diapers; the company matches 1:1. */
function story(rest: "carry" | "release" | null = "carry") {
  const b = new Book(makeDrive(), [makeNeed("water", 10), makeNeed("diapers", 5), makeNeed("blankets", 2)]);
  b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 3000 }, rest: rest ?? undefined });
  b.pledge({ id: "c", needId: "diapers", amount: { currency: "JPY", minor: 1000 } });
  b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 100_000 }, ratio: { ratioNum: 1, ratioDen: 1 } });
  return b;
}

const carried = (b: Book, at: string): RestCarried[] => {
  const evs = planCarries(b.state, at);
  for (const e of evs) b.apply(e);
  return evs;
};

describe("carry: the rest of a covered need's hold moves by itself", () => {
  it("moves the rest to the open need that lacks the most, leaving PayPal's hold untouched", () => {
    const b = story();
    b.fund(line("r1", 1, "diapers", 3, 600), hoursAfter(1)); // diapers lacks 2 of 5 (40 %), blankets 2 of 2 (100 %)
    const water = b.fund(line("r1", 2, "water", 10, 2000), hoursAfter(1)) as LineFunded; // water covered
    expect(water.shares.find((s) => s.pledgeId === "a")!.base).toBe(1000);
    const before = b.state;
    const balanceBefore = pledgeBalance(before, "a");

    const evs = planCarries(before, hoursAfter(1));
    expect(evs).toEqual([
      {
        id: "carry:drv1:a:water",
        at: hoursAfter(1),
        driveId: "drv1",
        type: "RestCarried",
        pledgeId: "a",
        fromNeedId: "water",
        toNeedId: "blankets",
        consent: { by: "Donor a", via: "pledge_choice" },
      },
    ]);
    b.apply(evs[0]);

    const after = pledgeBalance(b.state, "a");
    expect(after.needId).toBe("blankets");
    expect(after.rest).toBe("carry");
    expect(after.carried).toEqual([{ at: hoursAfter(1), fromNeedId: "water", toNeedId: "blankets" }]);
    for (const k of ["authorized", "captured", "capturePending", "accrued", "released", "uncollected", "reversed", "available", "authorizationId", "expiresAt"] as const) {
      expect(after[k]).toEqual(balanceBefore[k]);
    }
    // nothing new to ask PayPal for
    expect(planHoldMaintenance(b.state, hoursAfter(1))).toEqual(planHoldMaintenance(before, hoursAfter(1)));
    expect(planCaptures(b.state, hoursAfter(1), { force: true })).toEqual(planCaptures(before, hoursAfter(1), { force: true }));
    // the manual move is still the donor's (one per hold), a carry does not use it up
    expect(after.rebound).toBeNull();

    const blankets = b.fund(line("r2", 1, "blankets", 2, 1200), hoursAfter(2)) as LineFunded;
    expect(blankets.shares.find((s) => s.pledgeId === "a")!.base).toBe(600);
    expect(blankets.matchBase).toBe(600);
  });

  it("never moves a hold whose donor chose to release the rest (the default)", () => {
    for (const rest of ["release", null] as const) {
      const b = story(rest);
      expect("rest" in b.state.pledges.a).toBe(rest !== null); // null: the field is absent, as on every pledge made before
      b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
      expect(planCarries(b.state, hoursAfter(1))).toEqual([]);
      expect(pledgeBalance(b.state, "a").rest).toBe(rest === null ? undefined : "release");
      expect(pledgeBalance(b.state, "a").carried).toBeUndefined();
    }
  });

  it("breaks a tie by the drive's order of needs", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    expect(carryTarget(b.state, "a")).toBe("diapers"); // diapers 5/5 and blankets 2/2 both lack everything
  });

  it("follows the need further along a chain, one event per need left, and stops when nothing is open", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    expect(carried(b, hoursAfter(1)).map((e) => [e.id, e.toNeedId])).toEqual([["carry:drv1:a:water", "diapers"]]);
    b.fund(line("r2", 1, "diapers", 5, 1000), hoursAfter(2));
    expect(carried(b, hoursAfter(2)).map((e) => [e.id, e.toNeedId])).toEqual([["carry:drv1:a:diapers", "blankets"]]);
    b.fund(line("r3", 1, "blankets", 2, 400), hoursAfter(3));
    expect(planCarries(b.state, hoursAfter(3))).toEqual([]); // every need covered: the rest stays and is released at the close
    expect(pledgeBalance(b.state, "a").carried!.map((c) => c.toNeedId)).toEqual(["diapers", "blankets"]);
  });

  it("is idempotent: the same event again is a no-op, a second plan is empty, a forged copy is refused", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    const [ev] = carried(b, hoursAfter(1));
    const s = b.state;
    expect(applyEvent(s, ev)).toBe(s);
    expect(planCarries(s, hoursAfter(1))).toEqual([]);
    expect(() => applyEvent(s, { ...ev, id: "carry-again" })).toThrow(/stale_need/);
  });
});

describe("carry: refusals (red team)", () => {
  const forge = (_b: Book, over: Partial<RestCarried> = {}): RestCarried => ({
    id: "forged",
    at: hoursAfter(1),
    driveId: "drv1",
    type: "RestCarried",
    pledgeId: "a",
    fromNeedId: "water",
    toNeedId: "diapers",
    consent: { by: "Donor a", via: "pledge_choice" },
    ...over,
  });

  it("refuses a carry the donor did not choose, of a need still open, to another need than the rule's, and of the match", () => {
    const released = story("release");
    released.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    expect(() => applyEvent(released.state, forge(released))).toThrow(/not_carry/);

    const open = story();
    open.fund(line("r1", 1, "water", 4, 800), hoursAfter(1)); // water 4 of 10: still open
    expect(planCarries(open.state, hoursAfter(1))).toEqual([]);
    expect(() => applyEvent(open.state, forge(open))).toThrow(/need_open/);

    const wrong = story();
    wrong.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    expect(() => applyEvent(wrong.state, forge(wrong, { toNeedId: "blankets" }))).toThrow(/not_target/);
    expect(() => applyEvent(wrong.state, forge(wrong, { toNeedId: "nowhere" }))).toThrow(/unknown_need/);
    expect(() => applyEvent(wrong.state, forge(wrong, { fromNeedId: "diapers" }))).toThrow(/stale_need/);
    expect(() => applyEvent(wrong.state, forge(wrong, { consent: { by: "", via: "pledge_choice" } }))).toThrow(/consent/);
    expect(() => applyEvent(wrong.state, forge(wrong, { pledgeId: "m" }))).toThrow(/not_donor/);
    expect(() => applyEvent(wrong.state, forge(wrong, { pledgeId: "ghost" }))).toThrow(/unknown_pledge/);
  });

  it("refuses a company match that asks to keep the rest: it backs the whole drive already", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 10)]);
    const pledge = makePledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 1000 }, rest: "carry" });
    expect(() => b.apply({ id: "pc", at: T0, driveId: "drv1", type: "PledgeCreated", pledge })).toThrow(/match/);
    const odd = makePledge({ id: "d", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    expect(() => b.apply({ id: "pc2", at: T0, driveId: "drv1", type: "PledgeCreated", pledge: { ...odd, rest: "maybe" as never } })).toThrow(/rest/);
  });

  it("does not move a hold that is revoked, blocked, ended, about to end, spent, or a drive that is closing", () => {
    const covered = (setup: (b: Book) => void, at = hoursAfter(2)) => {
      const b = story();
      setup(b);
      b.fund(line("r1", 9, "water", 10, 2000), hoursAfter(1));
      return planCarries(b.state, at);
    };
    expect(covered((b) => b.event("PledgeRevoked", hoursAfter(0.5), { pledgeId: "a" }))).toEqual([]);
    expect(
      covered((b) => {
        b.fund(line("r0", 1, "water", 1, 100), hoursAfter(0.2));
        const [c] = planCaptures(b.state, hoursAfter(0.3), { force: true }).filter((x) => x.pledgeId === "a");
        b.submit(c, hoursAfter(0.3)).failCapture(c, hoursAfter(0.4), "INSTRUMENT_DECLINED");
      }),
    ).toEqual([]);
    expect(covered(() => undefined, daysAfter(29))).toEqual([]); // past the 29 days
    expect(covered(() => undefined, daysAfter(26.5))).toEqual([]); // inside the last 3 days, like a manual move
    // the whole hold went to water: nothing left to move
    const spent = new Book(makeDrive(), [makeNeed("water", 10), makeNeed("diapers", 5)]);
    spent.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 }, rest: "carry" });
    spent.fund(line("r1", 1, "water", 10, 1000), hoursAfter(1));
    expect(pledgeBalance(spent.state, "a").available).toBe(0);
    expect(planCarries(spent.state, hoursAfter(1))).toEqual([]);
    // closing
    const closing = story();
    closing.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    closing.event("DriveClosing", hoursAfter(1), {});
    expect(planCarries(closing.state, hoursAfter(1))).toEqual([]);
  });
});

describe("carry: with the manual move, three currencies and the close", () => {
  it("leaves the donor's one manual move, and carries after a manual move too", () => {
    const b = story();
    b.apply(rebindEvent(b.state, { pledgeId: "a", fromNeedId: "water", toNeedId: "blankets", at: hoursAfter(0.5), consent: { by: "Donor a", via: "statement" } }));
    b.fund(line("r1", 1, "blankets", 2, 400), hoursAfter(1));
    expect(carried(b, hoursAfter(1)).map((e) => [e.fromNeedId, e.toNeedId])).toEqual([["blankets", "water"]]); // water 10/10 lacks the most
    expect(pledgeBalance(b.state, "a").rebound).toMatchObject({ fromNeedId: "water", toNeedId: "blankets" });
  });

  it("carries EUR, USD and JPY holds on a USD drive without touching a cent at PayPal", () => {
    const b = new Book(makeDrive({ baseCurrency: "USD" }), [makeNeed("water", 4), makeNeed("ice", 30), makeNeed("blankets", 10)]);
    b.pledge({ id: "eur", needId: "water", amount: { currency: "EUR", minor: 2500 }, rate: "1.0737", rest: "carry" });
    b.pledge({ id: "jpy", needId: "water", amount: { currency: "JPY", minor: 4000 }, rate: "0.006614", rest: "carry" });
    b.pledge({ id: "usd", needId: "water", amount: { currency: "USD", minor: 3000 }, rest: "carry" });
    const w = b.fund(line("r1", 1, "water", 4, 1196), hoursAfter(1)) as LineFunded; // $11.96 for 4 gallons
    expect(w.fundedBase).toBe(1196);
    const before = ["eur", "jpy", "usd"].map((id) => pledgeBalance(b.state, id));
    const evs = carried(b, hoursAfter(1));
    expect(evs.map((e) => [e.pledgeId, e.toNeedId])).toEqual([
      ["eur", "ice"],
      ["jpy", "ice"],
      ["usd", "ice"],
    ]);
    ["eur", "jpy", "usd"].forEach((id, i) => {
      const after = pledgeBalance(b.state, id);
      expect([after.available, after.accrued, after.capacityBase]).toEqual([before[i].available, before[i].accrued, before[i].capacityBase]);
      expect(uncommitted(b.state.holds[id])).toBe(before[i].available);
    });
    const ice = b.fund(line("r2", 1, "ice", 10, 3290), hoursAfter(2)) as LineFunded; // $32.90 for 10 bags
    expect(ice.fundedBase).toBe(3290);
    expect(ice.shares.map((s) => s.quote.currency).sort()).toEqual(["EUR", "JPY", "USD"]);
    for (const s of ice.shares) expect(s.quote.minor).toBeLessThanOrEqual(pledgeBalance(b.state, s.pledgeId).accrued);
  });

  it("closes with pledged = spent + released on a carried hold", () => {
    const b = story();
    b.fund(line("r1", 1, "water", 10, 2000), hoursAfter(1));
    carried(b, hoursAfter(1)); // to diapers
    b.fund(line("r2", 1, "diapers", 2, 400), hoursAfter(2));
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
    // water 1000 (half of 2000), diapers: a and c by capacity (2000 : 1000) of the donors' 200
    expect(row.spent + row.released).toBe(3000);
    expect(row.spent).toBeGreaterThan(1000);
    expect(row.settled).toBe(true);
  });
});
