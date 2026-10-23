import { describe, expect, it } from "vitest";
import { allocateLine } from "./allocate";
import type { LedgerEvent, LineFunded } from "./events";
import { applyEvent, emptyLedger, uncommitted } from "./ledger";
import { captureSubmittedEvent, payoutSubmittedEvent, planCaptures, planPayout } from "./plan";
import { Book, daysAfter, hoursAfter, line, makeDrive, makeNeed, makePledge, T0 } from "./testing/builders";

const NOW = hoursAfter(2);

const book = () => new Book(makeDrive(), [makeNeed("water", 40)]);
const created = (b: Book, over: Parameters<typeof makePledge>[0]) =>
  ({ id: `pc-${over.id}`, at: T0, driveId: "drv1", type: "PledgeCreated", pledge: makePledge(over) }) as LedgerEvent;

describe("journal basics", () => {
  it("needs DriveOpened first and refuses events of another drive", () => {
    expect(() => applyEvent(emptyLedger(), { id: "x", at: T0, driveId: "drv1", type: "DriveClosing" })).toThrow(/unknown_drive/);
    const b = book();
    expect(() => b.apply({ id: "x", at: T0, driveId: "other", type: "DriveClosing" })).toThrow(/belongs to drive other/);
    expect(() => b.apply({ id: "x2", at: T0, driveId: "drv1", type: "DriveOpened", drive: makeDrive(), needs: [] })).toThrow(/already open/);
  });

  it("checks the event envelope", () => {
    const b = book();
    expect(() => b.apply({ id: "", at: T0, driveId: "drv1", type: "DriveClosing" })).toThrow(/without an id/);
    expect(() => b.apply({ id: "e", at: "yesterday", driveId: "drv1", type: "DriveClosing" })).toThrow(/invalid_time/);
    expect(() => b.apply({ id: "e", at: T0, driveId: "", type: "DriveClosing" })).toThrow(/missing driveId/);
    expect(() => b.apply({ id: "e", at: T0, driveId: "drv1", type: "Nope" } as unknown as LedgerEvent)).toThrow(/unknown event type/);
  });

  it("validates the opening", () => {
    const open = (drive = makeDrive(), needs = [makeNeed("w", 1)]) =>
      applyEvent(emptyLedger(), { id: "o", at: T0, driveId: drive.id, type: "DriveOpened", drive, needs });
    expect(() => open(makeDrive({ status: "closing" }))).toThrow(/status open/);
    expect(() => open(makeDrive({ batch: { maxAgeHours: 0, thresholdMinor: {} } }))).toThrow(/maxAgeHours/);
    expect(() => open(makeDrive({ batch: { maxAgeHours: 1, thresholdMinor: { JPY: 1.5 } } }))).toThrow(/threshold/);
    expect(() => open(undefined, [makeNeed("w", 2.5)])).toThrow(/whole number/);
    expect(() => open(undefined, [makeNeed("w", 1), makeNeed("w", 2)])).toThrow(/repeated/);
    expect(() => open(undefined, [makeNeed("w", 1, { driveId: "x" })])).toThrow(/belongs to drive x/);
  });

  it("applies an event id once", () => {
    const b = book();
    const e = created(b, { id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } });
    b.apply(e);
    expect(applyEvent(b.state, e)).toBe(b.state);
  });

  it("keeps ids like constructor or __proto__ as plain data", () => {
    const b = new Book(makeDrive(), [makeNeed("constructor", 5)]);
    b.pledge({ id: "__proto__", needId: "constructor", amount: { currency: "JPY", minor: 1000 } });
    const ev = b.fund(line("toString", 1, "constructor", 1, 100), NOW) as LineFunded;
    expect(ev.shares[0]).toMatchObject({ pledgeId: "__proto__", base: 100 });
    expect(b.state.holds["__proto__"].accrued).toBe(100);
    expect(Object.getPrototypeOf(b.state.holds)).toBe(Object.prototype);
  });
});

describe("pledges", () => {
  it("validates a new pledge against the drive", () => {
    const b = book();
    const jpy = { currency: "JPY" as const, minor: 100 };
    const bad = (over: Parameters<typeof makePledge>[0], msg: RegExp) => expect(() => b.apply(created(b, over))).toThrow(msg);
    bad({ id: "a", needId: "water", amount: { currency: "EUR", minor: 100 }, baseCurrency: "USD", rate: "160" }, /fx.base USD/);
    bad({ id: "a", needId: "water", amount: jpy, rate: "1.5" }, /same-currency rate must be 1/);
    bad({ id: "a", needId: "rice", amount: jpy }, /must back a need/);
    bad({ id: "a", needId: "water", amount: { currency: "JPY", minor: 0 } }, /positive integer/);
    bad({ id: "a", needId: "water", amount: jpy, driveId: "x" }, /belongs to drive x/);
    expect(() => b.apply({ ...created(b, { id: "a", needId: "water", amount: jpy }), pledge: { ...makePledge({ id: "a", needId: "water", amount: jpy }), status: "authorized" } } as LedgerEvent)).toThrow(/pending_approval/);
    const m = makePledge({ id: "m", kind: "match", amount: jpy });
    expect(() => b.apply({ ...created(b, { id: "m", kind: "match", amount: jpy }), pledge: { ...m, needId: "water" } } as LedgerEvent)).toThrow(/whole drive/);
    expect(() => b.apply({ ...created(b, { id: "m", kind: "match", amount: jpy }), pledge: { ...m, match: { ratioNum: 0, ratioDen: 1 } } } as LedgerEvent)).toThrow(/two positive integers/);
    const fx = makePledge({ id: "q", needId: "water", amount: { currency: "EUR", minor: 100 }, rate: "160" });
    expect(() => b.apply({ id: "q", at: T0, driveId: "drv1", type: "PledgeCreated", pledge: { ...fx, fx: { ...fx.fx, quote: "USD" } } })).toThrow(/fx.quote USD/);
  });

  it("allows several match holds only at the drive's ratio", () => {
    const b = book().pledge({ id: "m1", kind: "match", amount: { currency: "JPY", minor: 100 }, ratio: { ratioNum: 1, ratioDen: 1 } });
    expect(() => b.apply(created(b, { id: "m2", kind: "match", amount: { currency: "JPY", minor: 100 }, ratio: { ratioNum: 2, ratioDen: 1 } }))).toThrow(/differs/);
    b.apply(created(b, { id: "m3", kind: "match", amount: { currency: "JPY", minor: 100 }, ratio: { ratioNum: 2, ratioDen: 2 } }));
    expect(b.state.pledges.m3).toBeDefined();
  });

  it("refuses duplicates and pledges to a closing drive", () => {
    const b = book();
    b.apply(created(b, { id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } }));
    expect(() => b.apply({ ...created(b, { id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } }), id: "again" })).toThrow(/already exists/);
    b.event("DriveClosing", NOW, {});
    expect(() => b.apply(created(b, { id: "z", needId: "water", amount: { currency: "JPY", minor: 100 } }))).toThrow(/drive is closing/);
  });

  it("authorization starts the 3-day honor period and the 29-day life", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } }, hoursAfter(5), "card");
    expect(b.state.pledges.a).toMatchObject({
      status: "authorized",
      authorizedAt: hoursAfter(5),
      honorUntil: daysAfter(3, hoursAfter(5)),
      expiresAt: daysAfter(29, hoursAfter(5)),
      paymentSource: "card",
      paypal: { orderId: "ORDER-a", authorizationId: "AUTH-a" },
    });
    expect(b.state.holds.a).toMatchObject({ authorized: 100, authorizationIds: ["AUTH-a"] });
    const s = b.state;
    b.authorize("a", hoursAfter(6)); // the same authorization reported twice
    expect(b.state).toBe(s);
    expect(() => b.authorize("a", hoursAfter(6), "paypal", "AUTH-other")).toThrow(/is authorized/);
  });

  it("denied pledges stay out of the money", () => {
    const b = book();
    b.apply(created(b, { id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } }));
    b.event("PledgeDenied", T0, { pledgeId: "a" });
    expect(b.state.pledges.a.status).toBe("denied");
    expect(() => b.authorize("a")).toThrow(/is denied/);
    expect(() => b.event("HoldVoided", T0, { pledgeId: "a" })).toThrow(/denied pledge/);
    expect(() => b.event("PledgeRevoked", T0, { pledgeId: "a" })).toThrow(/is denied/);
  });

  it("reauthorization extends the honor period, keeps the 29 days, chains a new id", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 100 } });
    b.event("Reauthorized", daysAfter(5), { pledgeId: "a", requestId: "reauth:drv1:a:1", authorizationId: "AUTH-a2" });
    expect(b.state.pledges.a).toMatchObject({ honorUntil: daysAfter(8), expiresAt: daysAfter(29), reauthorizedAt: daysAfter(5), paypal: { authorizationId: "AUTH-a2" } });
    expect(b.state.holds.a.authorizationIds).toEqual(["AUTH-a", "AUTH-a2"]);
    expect(() => b.event("Reauthorized", daysAfter(6), { pledgeId: "a", requestId: "reauth:drv1:a:1", authorizationId: "AUTH-a3" })).not.toThrow(); // same request: no-op
    expect(b.state.holds.a.reauths).toHaveLength(1);
    expect(() => b.event("Reauthorized", daysAfter(6), { pledgeId: "a", requestId: "reauth:drv1:a:7", authorizationId: "X" })).toThrow(/reauth:\{driveId\}:\{pledgeId\}:2/);
    b.event("Reauthorized", daysAfter(6), { pledgeId: "a", requestId: "reauth:drv1:a:2", authorizationId: "AUTH-a2" });
    expect(b.state.holds.a.authorizationIds).toEqual(["AUTH-a", "AUTH-a2"]); // same id returned: no new link
  });
});

describe("lines in the reducer", () => {
  const setup = () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "EUR", minor: 1000 }, rate: "160" });
    b.pledge({ id: "m", kind: "match", amount: { currency: "JPY", minor: 10_000 } });
    const ev = allocateLine(b.state, line("r1", 1, "water", 2, 1000), NOW) as LineFunded;
    return { b, ev };
  };

  it("refuses a tampered allocation", () => {
    const { b, ev } = setup();
    const tamper = (f: (e: LineFunded) => LineFunded, msg: RegExp) => expect(() => applyEvent(b.state, f(structuredClone(ev)))).toThrow(msg);
    tamper((e) => ({ ...e, shares: e.shares.map((s, i) => (i === 0 ? { ...s, base: s.base + 1 } : s)) }), /do not add up/);
    tamper((e) => ({ ...e, fundedBase: e.fundedBase - 1, unfundedBase: e.unfundedBase + 1 }), /donor \+ match/);
    tamper((e) => ({ ...e, unfundedBase: 5 }), /funded \+ unfunded \+ rejected/);
    tamper((e) => ({ ...e, shares: e.shares.map((s) => (s.kind === "donor" ? { ...s, quote: { ...s.quote, minor: 1001 } } : s)) }), /exceeds the hold/);
    tamper((e) => ({ ...e, shares: e.shares.map((s) => (s.kind === "donor" ? { ...s, base: 100_000 } : s)) }), /exceeds its capacity/);
    tamper((e) => ({ ...e, shares: e.shares.map((s) => (s.kind === "donor" ? { ...s, matchBase: 0 } : s)) }), /attribution/);
    tamper((e) => ({ ...e, acceptedQty: 41, rejectedQty: -39 }), /lacks 40/);
    tamper((e) => ({ ...e, shares: [...e.shares, e.shares[0]] }), /two shares/);
    tamper((e) => ({ ...e, shares: e.shares.map((s) => (s.kind === "match" ? { ...s, kind: "donor" as const } : s)) }), /share kind/);
  });

  it("refuses a match beyond ratio x donor money", () => {
    const { b, ev } = setup();
    const e = structuredClone(ev);
    // move 1 yen from the donor to the match, attribution adjusted: still sums, but over the 1:1 ratio
    const donor = e.shares.find((s) => s.kind === "donor")!;
    const match = e.shares.find((s) => s.kind === "match")!;
    donor.base -= 1;
    donor.matchBase += 1;
    match.base += 1;
    e.donorBase -= 1;
    e.matchBase += 1;
    expect(() => applyEvent(b.state, e)).toThrow(/ratio/);
  });

  it("records the line and moves money into accrued", () => {
    const { b, ev } = setup();
    b.apply(ev);
    expect(b.state.holds.a).toMatchObject({ accrued: 313, accruals: [{ shareId: "r1:1@a", lineKey: "r1:1", minor: 313, at: NOW }] });
    expect(b.state.lineKeys).toEqual(["r1:1"]);
    expect(uncommitted(b.state.holds.a)).toBe(687);
  });
});

describe("captures in the reducer", () => {
  const setup = () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    b.fund(line("r1", 2, "water", 1, 200), hoursAfter(3));
    const [cmd] = planCaptures(b.state, NOW, { force: true });
    return { b, cmd };
  };

  it("submits, confirms, and marks the hold partially captured", () => {
    const { b, cmd } = setup();
    b.submit(cmd, NOW);
    expect(b.state.holds.a).toMatchObject({ accrued: 0, capturePending: 500, nextSeq: 2 });
    const s = b.state;
    b.submit(cmd, hoursAfter(4)); // the same submission recorded again
    expect(b.state).toBe(s);
    b.confirm(cmd, hoursAfter(4), "CAP-1", { currency: "JPY", minor: 49 });
    expect(b.state.holds.a).toMatchObject({ capturePending: 0, captured: 500 });
    expect(b.state.holds.a.batches[0]).toMatchObject({ status: "confirmed", captureId: "CAP-1", paypalFeeMinor: 49 });
    expect(b.state.pledges.a.status).toBe("partially_captured");
    const s2 = b.state;
    b.confirm(cmd, hoursAfter(5), "CAP-1"); // webhook delivered twice
    expect(b.state).toBe(s2);
    expect(() => b.confirm(cmd, hoursAfter(5), "CAP-other")).toThrow(/confirmed as CAP-1/);
    expect(() => b.failCapture(cmd, hoursAfter(5))).toThrow(/already confirmed/);
  });

  it("checks what a batch claims", () => {
    const { b, cmd } = setup();
    const ev = captureSubmittedEvent(cmd, NOW);
    expect(() => b.apply({ ...ev, seq: 2, requestId: "cap:drv1:a:2" })).toThrow(/expected batch seq 1/);
    expect(() => b.apply({ ...ev, requestId: "cap:drv1:a:x" })).toThrow(/requestId/);
    expect(() => b.apply({ ...ev, shareIds: ["nope"] })).toThrow(/not accrued/);
    expect(() => b.apply({ ...ev, shareIds: [] })).toThrow(/at least one share/);
    expect(() => b.apply({ ...ev, shareIds: [ev.shareIds[0], ev.shareIds[0]] })).toThrow(/repeated/);
    expect(() => b.apply({ ...ev, amount: { currency: "JPY", minor: 499 } })).toThrow(/must be 500/);
    b.apply({ ...ev, shareIds: [ev.shareIds[0]], amount: { currency: "JPY", minor: 300 } }); // a subset is fine
    expect(b.state.holds.a).toMatchObject({ accrued: 200, capturePending: 300 });
    const [next] = planCaptures(b.state, NOW, { force: true, retryAfterMinutes: 0 });
    expect(next).toMatchObject({ retry: true, seq: 1 }); // one in flight per hold
    expect(() => b.apply({ id: "second", at: NOW, driveId: "drv1", type: "CaptureSubmitted", pledgeId: "a", requestId: "cap:drv1:a:2", seq: 2, amount: { currency: "JPY", minor: 200 }, shareIds: ["r1:2@a"] })).toThrow(/still pending/);
    expect(() => b.confirm({ ...cmd, amount: { currency: "JPY", minor: 500 } }, NOW)).toThrow(/differs from the batch/);
  });

  it("a refused capture returns the shares to accrued with their dates", () => {
    const { b, cmd } = setup();
    b.submit(cmd, hoursAfter(5)).failCapture(cmd, hoursAfter(6), "INSTRUMENT_DECLINED");
    expect(b.state.holds.a).toMatchObject({ accrued: 500, capturePending: 0, nextSeq: 2 });
    expect(b.state.holds.a.accruals.map((a) => [a.shareId, a.at])).toEqual([
      ["r1:1@a", NOW],
      ["r1:2@a", hoursAfter(3)],
    ]);
    expect(b.state.holds.a.batches[0]).toMatchObject({ status: "failed", failReason: "INSTRUMENT_DECLINED" });
    const s = b.state;
    b.failCapture(cmd, hoursAfter(7));
    expect(b.state).toBe(s);
    expect(() => b.confirm(cmd, hoursAfter(7))).toThrow(/recorded as failed/);
  });

  it("a full capture closes the hold for voids", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 500 } });
    b.fund(line("r1", 1, "water", 1, 500), NOW);
    const [cmd] = planCaptures(b.state, NOW, { force: true });
    b.submit(cmd, NOW).confirm(cmd, NOW);
    expect(b.state.pledges.a.status).toBe("captured");
    expect(() => b.event("HoldVoided", NOW, { pledgeId: "a" })).toThrow(/fully captured/);
  });
});

describe("holds ending", () => {
  it("void releases what is left; accrued shares become uncollected", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    b.event("HoldVoided", hoursAfter(3), { pledgeId: "a" });
    expect(b.state.pledges.a.status).toBe("voided");
    expect(b.state.holds.a).toMatchObject({ accrued: 0, released: 1000, uncollected: 300, uncollectedShareIds: ["r1:1@a"] });
    const s = b.state;
    b.event("HoldExpired", hoursAfter(4), { pledgeId: "a" }); // PayPal reports expiry as a void and vice versa
    expect(b.state).toBe(s);
  });

  it("a capture refused after the hold ended counts as uncollected", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    const [cmd] = planCaptures(b.state, NOW, { force: true });
    b.submit(cmd, NOW).event("HoldExpired", hoursAfter(3), { pledgeId: "a" });
    expect(b.state.holds.a).toMatchObject({ released: 700, capturePending: 300 });
    b.failCapture(cmd, hoursAfter(4));
    expect(b.state.holds.a).toMatchObject({ released: 1000, uncollected: 300, capturePending: 0, accrued: 0 });
  });

  it("a capture confirmed after the hold ended is still money spent", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    const [cmd] = planCaptures(b.state, NOW, { force: true });
    b.submit(cmd, NOW).event("HoldExpired", hoursAfter(3), { pledgeId: "a" }).confirm(cmd, hoursAfter(4));
    expect(b.state.pledges.a.status).toBe("expired");
    expect(b.state.holds.a).toMatchObject({ captured: 300, released: 700 });
  });

  it("revocation keeps accrued shares but stops new funding", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    b.event("PledgeRevoked", hoursAfter(3), { pledgeId: "a" });
    expect(b.state.holds.a).toMatchObject({ accrued: 300, revokedAt: hoursAfter(3) });
    expect((b.fund(line("r1", 2, "water", 1, 100), hoursAfter(4)) as LineFunded).fundedBase).toBe(0);
    const s = b.state;
    b.event("PledgeRevoked", hoursAfter(5), { pledgeId: "a" });
    expect(b.state).toBe(s);
  });
});

describe("payouts and closing in the reducer", () => {
  it("pays a receipt once; a refusal opens a new sender_batch_id", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    b.fund(line("r1", 1, "water", 1, 300), NOW);
    const cmd = planPayout(b.state, "r1")!;
    const ev = payoutSubmittedEvent(cmd, NOW);
    expect(() => b.apply({ ...ev, amount: { currency: "JPY", minor: 299 } })).toThrow(/payout must be 300 JPY/);
    expect(() => b.apply({ ...ev, senderBatchId: "pay:drv1:r1:2" })).toThrow(/must be pay:drv1:r1/);
    expect(() => b.apply({ ...ev, receiptId: "r9", senderBatchId: "pay:drv1:r9" })).toThrow(/no funded lines/);
    b.apply(ev);
    expect(() => b.apply({ ...ev, id: "again-2", senderBatchId: "pay:drv1:r1:2" })).toThrow(/in flight or paid/);
    b.event("PayoutFailed", NOW, { receiptId: "r1", senderBatchId: "pay:drv1:r1", reason: "RECEIVER_UNREGISTERED" });
    expect(() => b.event("PayoutConfirmed", NOW, { receiptId: "r1", senderBatchId: "pay:drv1:r1", payoutBatchId: "B" })).toThrow(/already failed/);
    const retry = planPayout(b.state, "r1")!;
    expect(retry).toMatchObject({ senderBatchId: "pay:drv1:r1:2", attempt: 2, retry: false });
    b.apply(payoutSubmittedEvent(retry, NOW));
    b.event("PayoutConfirmed", NOW, { receiptId: "r1", senderBatchId: "pay:drv1:r1:2", payoutBatchId: "B2" });
    expect(b.state.payouts.r1.map((a) => [a.senderBatchId, a.status])).toEqual([
      ["pay:drv1:r1", "failed"],
      ["pay:drv1:r1:2", "confirmed"],
    ]);
    expect(() => b.event("PayoutFailed", NOW, { receiptId: "r1", senderBatchId: "nope", reason: "" })).toThrow(/no payout/);
  });

  it("closes only through DriveClosing and only with every hold settled", () => {
    const b = book().pledge({ id: "a", needId: "water", amount: { currency: "JPY", minor: 1000 } });
    expect(() => b.event("DriveClosed", NOW, {})).toThrow(/DriveClosing first/);
    b.event("DriveClosing", NOW, {});
    expect(() => b.event("DriveClosed", NOW, {})).toThrow(/not settled: a/);
    b.event("HoldVoided", NOW, { pledgeId: "a" });
    b.event("DriveClosed", NOW, {});
    expect(b.state.drive!.status).toBe("closed");
    expect(() => b.event("DriveClosing", NOW, {})).toThrow(/already closed/);
  });
});
