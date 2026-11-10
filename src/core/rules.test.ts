import { describe, expect, it } from "vitest";
import { planCarries } from "./carry";
import type { LineFunded } from "./events";
import { applyEvent, ruleAllows } from "./ledger";
import { rebindEvent } from "./rebind";
import { renewalPledge } from "./renew";
import { Book, hoursAfter, line, makeDrive, makeNeed, makePledge, T0 } from "./testing/builders";
import { donorStatement, pledgeBalance } from "./views";

// A donor's rules for the lines their hold may pay: "only these needs" and "at most X
// per unit" (in the donor's currency, the line's share of tax included). The split of
// a line goes only to holds whose rules allow it; the book refuses a share that breaks
// one; a carry, a manual move and a renewal keep to them.

/** JPY drive: water 40, food 20, toys 10. */
function drive() {
  return new Book(makeDrive(), [makeNeed("water", 40, { unit: "bottle 2 L" }), makeNeed("food", 20), makeNeed("toys", 10)]);
}

describe("rules: a line is split only between holds whose rules allow it", () => {
  it("leaves out a hold whose price cap the line passes, and the others pay all of it", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 120 } }); // at most ¥120 a bottle
    b.pledge({ id: "any", needId: "water", amount: { currency: "JPY", minor: 5000 } });
    const ok = b.fund(line("r1", 1, "water", 4, 400), hoursAfter(1)) as LineFunded; // ¥100 a bottle
    expect(ok.shares.map((s) => s.pledgeId).sort()).toEqual(["any", "cheap"]);
    const dear = b.fund(line("r1", 2, "water", 2, 300), hoursAfter(1)) as LineFunded; // ¥150 a bottle
    expect(dear.shares.map((s) => [s.pledgeId, s.base])).toEqual([["any", 300]]);
    expect(dear.donorCapacityBase).toBe(5000 - 200); // only the allowed hold's capacity counts
    // exactly at the cap is allowed
    expect(ruleAllows(b.state.pledges.cheap, "water", 360, 3)).toBe(true);
    expect(ruleAllows(b.state.pledges.cheap, "water", 361, 3)).toBe(false);
  });

  it("compares the cap in the donor's own currency, exactly (EUR cap on a JPY line)", () => {
    const b = drive();
    b.pledge({ id: "eur", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35", rules: { maxUnitMinor: 80 } }); // €0.80 a bottle = ¥129.88
    const p = b.state.pledges.eur;
    expect(ruleAllows(p, "water", 12988, 100)).toBe(true); // ¥129.88 a bottle
    expect(ruleAllows(p, "water", 12989, 100)).toBe(false);
    expect((b.fund(line("r1", 1, "water", 1, 129), hoursAfter(1)) as LineFunded).shares).toHaveLength(1);
    // the only hold of the need may not pay ¥130: the line is refused, not funded as "not enough pledges"
    expect(b.fund(line("r1", 2, "water", 1, 130), hoursAfter(1))).toMatchObject({ type: "LineRejected", code: "donor_rules" });
  });

  it("keeps the company match to its own rules: a line it refuses is paid by donors alone", () => {
    const b = drive();
    b.pledge({ id: "d", needId: "toys", amount: { currency: "JPY", minor: 10_000 } });
    b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 100_000 }, ratio: { ratioNum: 1, ratioDen: 1 }, rules: { needs: ["water", "food"] } });
    const toys = b.fund(line("r1", 1, "toys", 2, 1000), hoursAfter(1)) as LineFunded;
    expect([toys.donorBase, toys.matchBase]).toEqual([1000, 0]);
    b.pledge({ id: "w", needId: "water", amount: { currency: "JPY", minor: 10_000 } });
    const water = b.fund(line("r2", 1, "water", 4, 400), hoursAfter(2)) as LineFunded;
    expect([water.donorBase, water.matchBase]).toEqual([200, 200]);
  });

  it("refuses a share that breaks a rule, even written by hand", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 120 } });
    const forged: LineFunded = {
      id: "forged",
      at: hoursAfter(1),
      driveId: "drv1",
      type: "LineFunded",
      line: line("r1", 1, "water", 2, 300),
      acceptedQty: 2,
      rejectedQty: 0,
      rejectedBase: 0,
      fundedBase: 300,
      unfundedBase: 0,
      donorBase: 300,
      matchBase: 0,
      donorCapacityBase: 5000,
      matchCapacityBase: 0,
      matchRatio: null,
      shares: [{ pledgeId: "cheap", kind: "donor", base: 300, quote: { currency: "JPY", minor: 300 }, matchBase: 0, honored: true }],
    };
    expect(() => applyEvent(b.state, forged)).toThrow(/rule/);
  });
});

describe("rules: carries, moves and renewals keep to them", () => {
  it("carries the rest only to a need the donor allows, and not at all when none is open", () => {
    const b = drive();
    b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rest: "carry", rules: { needs: ["water", "food"] } });
    b.fund(line("r1", 1, "water", 40, 4000), hoursAfter(1)); // water covered; toys lacks the most (10/10) but is not allowed
    expect(planCarries(b.state, hoursAfter(1)).map((e) => e.toNeedId)).toEqual(["food"]);
    b.apply(planCarries(b.state, hoursAfter(1))[0]);
    b.fund(line("r2", 1, "food", 20, 2000), hoursAfter(2)); // food covered too: only toys left, not allowed
    expect(planCarries(b.state, hoursAfter(2))).toEqual([]);
  });

  it("refuses a manual move to a need the donor's rules leave out", () => {
    const b = drive();
    b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rules: { needs: ["water", "food"] } });
    expect(() => rebindEvent(b.state, { pledgeId: "a", fromNeedId: "water", toNeedId: "toys", at: hoursAfter(1), consent: { by: "Donor a", via: "statement" } })).toThrow(/rule_forbids/);
    expect(rebindEvent(b.state, { pledgeId: "a", fromNeedId: "water", toNeedId: "food", at: hoursAfter(1), consent: { by: "Donor a", via: "statement" } }).toNeedId).toBe("food");
  });

  it("renews with the same rules, and refuses a renewal that changes them", () => {
    const b = drive();
    b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rules: { needs: ["water"], maxUnitMinor: 150 } });
    const r = renewalPledge(b.state, "a", hoursAfter(1));
    expect(r.rules).toEqual({ needs: ["water"], maxUnitMinor: 150 });
    expect(() => b.apply({ id: "pc", at: hoursAfter(1), driveId: "drv1", type: "PledgeCreated", pledge: { ...r, rules: { maxUnitMinor: 500 }, paypal: { orderId: "O" } } })).toThrow(/rules/);
  });

  it("moves a price cap only to a need counted in the same unit (¥100 a bottle never becomes ¥100 a pack)", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 40, { unit: "bottle 2 L" }), makeNeed("tea", 20, { unit: "bottle 2 L" }), makeNeed("diapers", 10, { unit: "pack" })]);
    b.pledge({ id: "capped", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rest: "carry", rules: { maxUnitMinor: 100 } });
    b.pledge({ id: "free", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rest: "carry" });
    const move = (to: string) => () => rebindEvent(b.state, { pledgeId: "capped", fromNeedId: "water", toNeedId: to, at: hoursAfter(1), consent: { by: "Donor", via: "statement" } });
    expect(move("diapers")).toThrow(/rule_forbids.*per bottle 2 L.*per pack/);
    expect(move("tea")().toNeedId).toBe("tea");
    // the carry: diapers lacks the most (10 of 10; tea 15 of 20) but is counted per pack; the capped hold goes to tea, the other to diapers
    b.fund(line("r0", 1, "tea", 5, 450), hoursAfter(1));
    b.fund(line("r1", 1, "water", 40, 3600), hoursAfter(1));
    expect(planCarries(b.state, hoursAfter(1)).map((e) => [e.pledgeId, e.toNeedId])).toEqual([["capped", "tea"], ["free", "diapers"]]);
  });

  it("takes renewal rules listing the same needs in another order as the same rules", () => {
    const b = drive();
    b.pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 10_000 }, rules: { needs: ["water", "food"], maxUnitMinor: 150 } });
    const r = renewalPledge(b.state, "a", hoursAfter(1));
    expect(() => b.apply({ id: "pc", at: hoursAfter(1), driveId: "drv1", type: "PledgeCreated", pledge: { ...r, rules: { maxUnitMinor: 150, needs: ["food", "water"] }, paypal: { orderId: "O" } } })).not.toThrow();
  });

  it("refuses rules that cannot hold: an unknown need, leaving out the pledge's own need, a cap of zero, an empty rule", () => {
    const b = drive();
    const bad = (rules: unknown) => () =>
      b.apply({ id: `pc-${JSON.stringify(rules)}`, at: T0, driveId: "drv1", type: "PledgeCreated", pledge: { ...makePledge({ id: `x${JSON.stringify(rules)}`, needId: "water", amount: { currency: "JPY", minor: 1000 } }), rules: rules as never } });
    expect(bad({ needs: ["water", "rice"] })).toThrow(/rice/);
    expect(bad({ needs: ["food"] })).toThrow(/own need/);
    expect(bad({ needs: [] })).toThrow(/rules/);
    expect(bad({ maxUnitMinor: 0 })).toThrow(/rules/);
    expect(bad({})).toThrow(/rules/);
  });
});

describe("rules: the donor sees them, and the lines they kept the hold out of", () => {
  it("shows the rules on the balance and each line of the donor's need their price cap left out", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 120 } });
    b.pledge({ id: "any", needId: "water", amount: { currency: "JPY", minor: 5000 } });
    b.fund(line("r1", 1, "water", 4, 400), hoursAfter(1));
    b.fund(line("r1", 2, "water", 2, 300), hoursAfter(1)); // ¥150 a bottle: left out
    expect(pledgeBalance(b.state, "cheap").rules).toEqual({ maxUnitMinor: 120 });
    expect(pledgeBalance(b.state, "any").rules).toBeUndefined();
    const st = donorStatement(b.state, "cheap");
    expect(st.ruledOut).toEqual([{ receiptId: "r1", lineNo: 2, needId: "water", qty: 2, amountBase: 300, unitQuote: 150, reason: "price", funded: true }]);
    expect(donorStatement(b.state, "any").ruledOut).toBeUndefined();
  });

  it("shows the price per unit rounded up, so a line kept out never reads as at or below the cap", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 120 } });
    b.pledge({ id: "any", needId: "water", amount: { currency: "JPY", minor: 5000 } });
    b.fund(line("r1", 1, "water", 3, 361), hoursAfter(1)); // ¥120.33 a bottle: above ¥120
    expect(donorStatement(b.state, "cheap").ruledOut!.map((r) => r.unitQuote)).toEqual([121]);
  });

  it("lists only lines split while the hold was live and backed that need", () => {
    const b = new Book(makeDrive(), [makeNeed("water", 40, { unit: "bottle 2 L" }), makeNeed("tea", 20, { unit: "bottle 2 L" })]);
    b.pledge({ id: "any", needId: "water", amount: { currency: "JPY", minor: 20_000 } });
    b.fund(line("r0", 1, "water", 2, 400), hoursAfter(1)); // before "cheap" exists
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 120 } }, hoursAfter(2));
    b.fund(line("r1", 1, "water", 2, 400), hoursAfter(3)); // ¥200 a bottle, the hold is live: listed
    b.apply(rebindEvent(b.state, { pledgeId: "cheap", fromNeedId: "water", toNeedId: "tea", at: hoursAfter(4), consent: { by: "Donor cheap", via: "statement" } }));
    b.fund(line("r2", 1, "water", 2, 400), hoursAfter(5)); // water again, but the hold now backs tea: not listed
    expect(donorStatement(b.state, "cheap").ruledOut!.map((r) => r.receiptId)).toEqual(["r1"]);
  });

  it("lists a line for the match only when donors paid part of it", () => {
    const b = drive();
    b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 100_000 }, ratio: { ratioNum: 1, ratioDen: 1 }, rules: { needs: ["water", "food"] } });
    b.fund(line("r1", 1, "toys", 2, 1000), hoursAfter(1)); // no donor on toys: the match could not have paid anyway
    b.pledge({ id: "d", needId: "toys", amount: { currency: "JPY", minor: 10_000 } }, hoursAfter(2));
    b.fund(line("r2", 1, "toys", 2, 1000), hoursAfter(3)); // donors paid it: the match's rules kept it out
    expect(donorStatement(b.state, "m").ruledOut).toEqual([{ receiptId: "r2", lineNo: 1, needId: "toys", qty: 2, amountBase: 1000, unitQuote: 500, reason: "need", funded: true }]);
  });
});

describe("rules: a line no hold of its need may pay is refused, and the need stays open", () => {
  it("refuses a dearer line every hold's cap keeps out, then funds a cheaper one for the same need (JPY)", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 100 } }); // at most ¥100 a bottle
    const dear = b.fund(line("r1", 1, "water", 40, 4320), hoursAfter(1)); // ¥108 a bottle
    expect(dear).toMatchObject({ type: "LineRejected", code: "donor_rules", needId: "water", needQty: 40, amountBase: 4320, ruledOut: ["cheap"] });
    expect(b.state.qtyCovered.water).toBe(0); // the need is not used up
    expect(b.state.holds.cheap.accrued).toBe(0);
    const ok = b.fund(line("r2", 1, "water", 40, 3600), hoursAfter(2)) as LineFunded; // ¥90 a bottle
    expect([ok.type, ok.acceptedQty, ok.fundedBase]).toEqual(["LineFunded", 40, 3600]);
    expect(donorStatement(b.state, "cheap").ruledOut).toEqual([{ receiptId: "r1", lineNo: 1, needId: "water", qty: 40, amountBase: 4320, unitQuote: 108, reason: "price", funded: false }]);
  });

  it("does the same in EUR and USD holds on a JPY drive, exactly at the boundary", () => {
    const b = drive();
    b.pledge({ id: "eur", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35", rules: { maxUnitMinor: 80 } }); // ¥129.88 a bottle
    b.pledge({ id: "usd", needId: "water", amount: { currency: "USD", minor: 2000 }, rate: "151.20", rules: { maxUnitMinor: 85 } }); // ¥128.52 a bottle
    expect(b.fund(line("r1", 1, "water", 100, 12989), hoursAfter(1))).toMatchObject({ type: "LineRejected", code: "donor_rules", ruledOut: ["eur", "usd"] });
    const atEur = b.fund(line("r2", 1, "water", 100, 12988), hoursAfter(1)) as LineFunded; // only the EUR hold's cap allows it
    expect(atEur.shares.map((s) => s.pledgeId)).toEqual(["eur"]);
    expect(atEur.ruledOut).toEqual(["usd"]);
  });

  it("keeps the old reading when no rule is involved: a need without holds is funded as 'not enough pledges'", () => {
    const b = drive();
    const ev = b.fund(line("r1", 1, "toys", 2, 1000), hoursAfter(1)) as LineFunded;
    expect([ev.type, ev.unfundedBase, ev.ruledOut]).toEqual(["LineFunded", 1000, undefined]);
    expect(b.state.qtyCovered.toys).toBe(2);
  });

  it("refuses a line that names holds kept out untruthfully", () => {
    const b = drive();
    b.pledge({ id: "cheap", needId: "water", amount: { currency: "JPY", minor: 5000 }, rules: { maxUnitMinor: 100 } });
    b.pledge({ id: "any", needId: "water", amount: { currency: "JPY", minor: 5000 } });
    const reject = { id: "x", at: hoursAfter(1), driveId: "drv1", type: "LineRejected" as const, receiptId: "r9", lineNo: 1, needId: "water", needQty: 2, amountBase: 100, code: "donor_rules", reasonEn: "" };
    expect(() => applyEvent(b.state, { ...reject, ruledOut: ["cheap"] })).toThrow(/allow this line/); // ¥50 a bottle is within the cap
    expect(() => applyEvent(b.state, { ...reject, amountBase: 400, ruledOut: ["ghost"] })).toThrow(/unknown pledge/);
    expect(() => applyEvent(b.state, { ...reject, code: "alcohol", amountBase: 400, ruledOut: ["cheap"] })).toThrow(/donor_rules/);
    const funded = b.fund(line("r1", 1, "water", 2, 400), hoursAfter(1)) as LineFunded; // ¥200: "any" pays, "cheap" kept out
    expect(funded.ruledOut).toEqual(["cheap"]);
    const forged = { ...funded, id: "y", line: { ...funded.line, receiptId: "r2" }, ruledOut: ["cheap", "any"] };
    expect(() => applyEvent(b.state, forged)).toThrow(/with a share|allow this line/);
  });
});
