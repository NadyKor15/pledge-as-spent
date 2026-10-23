import { describe, expect, it } from "vitest";
import { allocateLine, rejectLine, splitMatch } from "./allocate";
import type { LineFunded, LineRejected } from "./events";
import { applyEvent, emptyLedger } from "./ledger";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, makePledge, T0 } from "./testing/builders";

const NOW = hoursAfter(2);

function waterBook(qty = 40) {
  return new Book(makeDrive(), [makeNeed("water", qty), makeNeed("diapers", 6)]);
}

const funded = (ev: unknown): LineFunded => {
  expect((ev as LineFunded).type).toBe("LineFunded");
  return ev as LineFunded;
};

const shareOf = (ev: LineFunded, pledgeId: string) => ev.shares.find((s) => s.pledgeId === pledgeId);

describe("splitMatch (SPEC §3.2)", () => {
  const one = { num: 1, den: 1 };

  it("match has room: half and half at 1:1, the odd unit to the donors", () => {
    expect(splitMatch(1000, 10_000, 10_000, one)).toEqual({ m: 500, d: 500, funded: 1000, unfunded: 0 });
    expect(splitMatch(1001, 10_000, 10_000, one)).toEqual({ m: 500, d: 501, funded: 1001, unfunded: 0 });
  });

  it("follows other ratios", () => {
    expect(splitMatch(900, 10_000, 10_000, { num: 2, den: 1 })).toEqual({ m: 600, d: 300, funded: 900, unfunded: 0 });
    expect(splitMatch(900, 10_000, 10_000, { num: 1, den: 2 })).toEqual({ m: 300, d: 600, funded: 900, unfunded: 0 });
  });

  it("match runs out: the match gives what it has, donors carry the rest", () => {
    expect(splitMatch(1000, 10_000, 200, one)).toEqual({ m: 200, d: 800, funded: 1000, unfunded: 0 });
  });

  it("donors fall short: the match is cut to ratio x donor money", () => {
    expect(splitMatch(1000, 300, 10_000, one)).toEqual({ m: 300, d: 300, funded: 600, unfunded: 400 });
    expect(splitMatch(1000, 300, 10_000, { num: 1, den: 2 })).toEqual({ m: 150, d: 300, funded: 450, unfunded: 550 });
  });

  it("both fall short", () => {
    expect(splitMatch(1000, 300, 100, one)).toEqual({ m: 100, d: 300, funded: 400, unfunded: 600 });
  });

  it("no match pledge, or a match with nothing left", () => {
    expect(splitMatch(1000, 600, 0, null)).toEqual({ m: 0, d: 600, funded: 600, unfunded: 400 });
    expect(splitMatch(1000, 5000, 0, one)).toEqual({ m: 0, d: 1000, funded: 1000, unfunded: 0 });
  });

  it("nothing to fund, or nobody to fund it", () => {
    expect(splitMatch(0, 100, 100, one)).toEqual({ m: 0, d: 0, funded: 0, unfunded: 0 });
    expect(splitMatch(1000, 0, 10_000, one)).toEqual({ m: 0, d: 0, funded: 0, unfunded: 1000 });
  });

  it("rejects non-integer or negative inputs", () => {
    expect(() => splitMatch(-1, 0, 0, null)).toThrow(/invalid_amount/);
    expect(() => splitMatch(1.5, 0, 0, null)).toThrow(/invalid_amount/);
  });
});

describe("allocateLine (SPEC §3)", () => {
  it("match has room: the donor pays half, converted into euros half-up", () => {
    const b = waterBook()
      .pledge({ id: "anna", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35" })
      .pledge({ id: "match", kind: "match", amount: { currency: "JPY", minor: 500_000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 4, 432), NOW));
    expect(ev).toMatchObject({ fundedBase: 432, donorBase: 216, matchBase: 216, unfundedBase: 0, rejectedBase: 0 });
    expect(ev.donorCapacityBase).toBe(3247);
    expect(ev.matchCapacityBase).toBe(500_000);
    expect(shareOf(ev, "anna")).toEqual({ pledgeId: "anna", kind: "donor", base: 216, quote: { currency: "EUR", minor: 133 }, matchBase: 216 });
    expect(shareOf(ev, "match")).toEqual({ pledgeId: "match", kind: "match", base: 216, quote: { currency: "JPY", minor: 216 }, matchBase: 0 });
    expect(b.state.holds.anna.accrued).toBe(133);
    expect(b.state.qtyCovered.water).toBe(4);
  });

  it("match runs out: it gives its last yen and the donor carries the rest", () => {
    const b = waterBook()
      .pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 10_000 } })
      .pledge({ id: "match", kind: "match", amount: { currency: "JPY", minor: 100 } });
    const ev = funded(b.fund(line("r1", 1, "water", 2, 1000), NOW));
    expect(ev).toMatchObject({ matchBase: 100, donorBase: 900, fundedBase: 1000, unfundedBase: 0 });
    // the match hold is now empty, so the next line is donors only
    const ev2 = funded(b.fund(line("r1", 2, "water", 2, 1000), NOW));
    expect(ev2).toMatchObject({ matchBase: 0, donorBase: 1000, matchCapacityBase: 0 });
  });

  it("donors are not enough: the match is held to their money, the rest is unfunded", () => {
    const b = waterBook()
      .pledge({ id: "anna", needId: "water", amount: { currency: "EUR", minor: 2000 }, rate: "162.35" })
      .pledge({ id: "match", kind: "match", amount: { currency: "JPY", minor: 500_000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 10, 10_000), NOW));
    expect(ev).toMatchObject({ donorBase: 3247, matchBase: 3247, fundedBase: 6494, unfundedBase: 3506 });
    expect(shareOf(ev, "anna")!.quote.minor).toBe(2000);
    expect(b.state.holds.anna).toMatchObject({ accrued: 2000 });
    expect(b.state.qtyCovered.water).toBe(10); // the goods were bought; the gap goes to the coordinator
  });

  it("need already covered: the whole line is refused, no money moves", () => {
    const b = waterBook(4).pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 10_000 } });
    funded(b.fund(line("r1", 1, "water", 4, 400), NOW));
    const before = b.state.holds.don.accrued;
    const ev = b.fund(line("r2", 1, "water", 3, 300), NOW) as LineRejected;
    expect(ev).toMatchObject({ type: "LineRejected", code: "need_covered", amountBase: 300, reasonEn: "water is covered: 4 of 4." });
    expect(b.state.holds.don.accrued).toBe(before);
  });

  it("need almost covered: only the missing units are funded, pro rata, rounded down", () => {
    const b = waterBook(40).pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 100_000 } });
    funded(b.fund(line("r1", 1, "water", 36, 3600), NOW));
    const ev = funded(b.fund(line("r2", 1, "water", 6, 648), NOW));
    expect(ev).toMatchObject({ acceptedQty: 4, rejectedQty: 2, fundedBase: 432, rejectedBase: 216 });
    expect(b.state.qtyCovered.water).toBe(40);

    const b2 = waterBook(1).pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 100_000 } });
    const ev2 = funded(b2.fund(line("r1", 1, "water", 3, 1000), NOW));
    expect(ev2).toMatchObject({ acceptedQty: 1, fundedBase: 333, rejectedBase: 667 });
  });

  it("splits donor money by remaining capacity, largest remainder, ties to the smaller id", () => {
    const b = waterBook()
      .pledge({ id: "p-b", needId: "water", amount: { currency: "JPY", minor: 1000 } })
      .pledge({ id: "p-a", needId: "water", amount: { currency: "JPY", minor: 1000 } })
      .pledge({ id: "p-c", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 100), NOW));
    expect(ev.shares.map((s) => [s.pledgeId, s.base])).toEqual([
      ["p-b", 33],
      ["p-a", 34],
      ["p-c", 33],
    ]);
  });

  it("weights by capacity and attributes the match by donor share", () => {
    const b = waterBook()
      .pledge({ id: "small", needId: "water", amount: { currency: "JPY", minor: 1000 } })
      .pledge({ id: "big", needId: "water", amount: { currency: "JPY", minor: 3000 } })
      .pledge({ id: "diap", needId: "diapers", amount: { currency: "JPY", minor: 9000 } })
      .pledge({ id: "match", kind: "match", amount: { currency: "JPY", minor: 50_000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 800), NOW));
    expect(ev.shares.map((s) => [s.pledgeId, s.base, s.matchBase])).toEqual([
      ["small", 100, 100],
      ["big", 300, 300],
      ["match", 400, 0],
    ]);
    expect(shareOf(ev, "diap")).toBeUndefined(); // another need's donor never pays
  });

  it("uses the match pool across several match holds, all at the same ratio", () => {
    const b = waterBook()
      .pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 10_000 } })
      .pledge({ id: "m1", kind: "match", amount: { currency: "JPY", minor: 100 } })
      .pledge({ id: "m2", kind: "match", amount: { currency: "JPY", minor: 300 } });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 2000), NOW));
    expect(ev.shares.map((s) => [s.pledgeId, s.base])).toEqual([
      ["don", 1600],
      ["m1", 100],
      ["m2", 300],
    ]);
  });

  it("only draws on live, unrevoked holds inside their 29 days", () => {
    const at20 = daysAfter(20);
    const b = waterBook()
      .pledge({ id: "old", needId: "water", amount: { currency: "JPY", minor: 1000 } }, T0)
      .pledge({ id: "fresh", needId: "water", amount: { currency: "JPY", minor: 1000 } }, at20)
      .pledge({ id: "gone", needId: "water", amount: { currency: "JPY", minor: 1000 } }, at20);
    b.apply({ id: "pc-pend", at: at20, driveId: "drv1", type: "PledgeCreated", pledge: makePledge({ id: "pend", needId: "water", amount: { currency: "JPY", minor: 1000 } }) });
    b.apply({ id: "pc-den", at: at20, driveId: "drv1", type: "PledgeCreated", pledge: makePledge({ id: "den", needId: "water", amount: { currency: "JPY", minor: 1000 } }) });
    b.event("PledgeDenied", at20, { pledgeId: "den" });
    b.event("PledgeRevoked", at20, { pledgeId: "gone" });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 500), daysAfter(29.5)));
    expect(ev.shares.map((s) => s.pledgeId)).toEqual(["fresh"]);
    expect(ev).toMatchObject({ donorCapacityBase: 1000, fundedBase: 500 });
  });

  it("refuses new lines once the drive is closing", () => {
    const b = waterBook().pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.event("DriveClosing", NOW, {});
    expect(b.fund(line("r1", 1, "water", 1, 100), NOW)).toMatchObject({ type: "LineRejected", code: "drive_closed" });
  });

  it("is idempotent: the same receipt line again changes nothing", () => {
    const b = waterBook().pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 100), NOW));
    expect(allocateLine(b.state, line("r1", 1, "water", 1, 100), hoursAfter(5))).toBeNull();
    const before = b.state;
    expect(applyEvent(before, { ...ev, id: "another-id" })).toBe(before); // same line under a new event id
    expect(applyEvent(before, ev)).toBe(before); // same event id
  });

  it("is deterministic", () => {
    const build = () =>
      waterBook()
        .pledge({ id: "a", needId: "water", amount: { currency: "EUR", minor: 777 }, rate: "161.0001" })
        .pledge({ id: "b", needId: "water", amount: { currency: "USD", minor: 999 }, rate: "151.2" })
        .pledge({ id: "m", kind: "match", amount: { currency: "GBP", minor: 5000 }, rate: "190.5", ratio: { ratioNum: 3, ratioDen: 2 } });
    expect(allocateLine(build().state, line("r", 1, "water", 3, 4321), NOW)).toEqual(allocateLine(build().state, line("r", 1, "water", 3, 4321), NOW));
  });

  it("a share too small to show in the donor's currency is funded in base but charges nothing", () => {
    const b = waterBook().pledge({ id: "gbp", needId: "water", amount: { currency: "GBP", minor: 100 }, rate: "250" });
    const ev = funded(b.fund(line("r1", 1, "water", 1, 1), NOW)); // 1 yen = 0.4 pence -> 0
    expect(shareOf(ev, "gbp")).toMatchObject({ base: 1, quote: { currency: "GBP", minor: 0 } });
    expect(b.state.holds.gbp.accrued).toBe(0);
  });

  it("funds a zero-amount line without money", () => {
    const b = waterBook().pledge({ id: "don", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    const ev = funded(b.fund(line("r1", 1, "water", 2, 0), NOW));
    expect(ev).toMatchObject({ fundedBase: 0, shares: [] });
    expect(b.state.qtyCovered.water).toBe(2);
  });

  it("rejects malformed lines instead of guessing", () => {
    const b = waterBook();
    expect(() => allocateLine(b.state, line("r", 1, "water", 1.5, 100), NOW)).toThrow(/whole number/);
    expect(() => allocateLine(b.state, line("r", 1, "water", 0, 100), NOW)).toThrow(/invalid_line/);
    expect(() => allocateLine(b.state, line("r", 1, "water", 1, -1), NOW)).toThrow(/invalid_line/);
    expect(() => allocateLine(b.state, line("r", 1, "water", 1, 10.5), NOW)).toThrow(/invalid_line/);
    expect(() => allocateLine(b.state, line("r", 0, "water", 1, 10), NOW)).toThrow(/invalid_line/);
    expect(() => allocateLine(b.state, line("", 1, "water", 1, 10), NOW)).toThrow(/invalid_line/);
    expect(() => allocateLine(b.state, line("r", 1, "rice", 1, 10), NOW)).toThrow(/unknown_need/);
    expect(() => allocateLine(b.state, line("r", 1, "constructor", 1, 10), NOW)).toThrow(/unknown_need/);
    expect(() => allocateLine(b.state, line("r", 1, "water", 1, 10), "2026-11-02T10:00:00")).toThrow(/invalid_time/);
    expect(() => allocateLine(emptyLedger(), line("r", 1, "water", 1, 10), NOW)).toThrow(/unknown_drive/);
  });
});

describe("rejectLine", () => {
  it("records a refused line once, with the receipts module's code", () => {
    const b = waterBook();
    const ev = rejectLine(b.state, { receiptId: "r1", lineNo: 9, needId: null, needQty: null, amountBase: 436, code: "alcohol", reasonEn: "Beer." }, NOW)!;
    expect(ev).toMatchObject({ id: "line:drv1:r1:9", type: "LineRejected", code: "alcohol", amountBase: 436 });
    b.apply(ev);
    expect(rejectLine(b.state, { receiptId: "r1", lineNo: 9, needId: null, needQty: null, amountBase: 436, code: "alcohol", reasonEn: "" }, NOW)).toBeNull();
    // a line refused upstream can no longer be funded either
    expect(allocateLine(b.state, line("r1", 9, "water", 1, 436), NOW)).toBeNull();
  });

  it("validates its input", () => {
    const b = waterBook();
    const base = { receiptId: "r1", lineNo: 1, needId: null, needQty: null, amountBase: 10, code: "x", reasonEn: "" };
    expect(() => rejectLine(b.state, { ...base, amountBase: -1 }, NOW)).toThrow(/invalid_line/);
    expect(() => rejectLine(b.state, { ...base, code: "" }, NOW)).toThrow(/invalid_line/);
    expect(() => rejectLine(b.state, { ...base, lineNo: 0 }, NOW)).toThrow(/invalid_line/);
    expect(() => rejectLine(b.state, { ...base, needId: "rice" }, NOW)).toThrow(/unknown_need/);
  });
});
