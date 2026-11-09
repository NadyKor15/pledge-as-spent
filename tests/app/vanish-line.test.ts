import { describe, expect, it } from "vitest";
import type { CheckResult, CheckRow } from "../../src/server/paypal-check";
import { vanishLine, type VanishHold } from "../../src/ui/statement/vanish";
import type { JournalCall } from "../../src/ui/types";

// "What if we vanish?" on a donor's statement: the day PayPal ends the hold by itself, from the book; PayPal's own word
// on it once the donor asks PayPal; the day PayPal voided it once the hold is over.

const live: VanishHold = { pledgeId: "d.water", status: "authorized", revoked: false, expiresAt: "2026-12-08T04:45:39.000Z", authorizationId: "1RV76766T26737437" };

const voidCall = (status: number, ts = "2026-11-09T04:46:49.202Z"): JournalCall =>
  ({ id: 1, ts, driveId: "d", method: "POST", path: "/v2/payments/authorizations/1RV76766T26737437/void", requestId: "void:d:d.water", httpStatus: status, debugId: null, ids: { id: "1RV76766T26737437", status: "VOIDED" } }) as unknown as JournalCall;

const answer = (row: Omit<Partial<CheckRow>, "paypal"> & { paypal: Partial<CheckRow["paypal"]> }): CheckResult =>
  ({ rows: [{ kind: "authorization", id: "1RV76766T26737437", pledgeId: "d.water", receiptId: null, book: { expires: live.expiresAt }, expiry: "agrees", ...row, paypal: { http: 200, ...row.paypal } }] }) as unknown as CheckResult;

describe("the statement's line for 'what if we vanish?'", () => {
  it("a live hold: the day PayPal ends it, from the book, and nothing more can be charged after that", () => {
    expect(vanishLine(live, [], null)).toEqual({ text: "If Pledge-as-Spent disappears today, PayPal ends this hold by 8 Dec 2026, and nothing more can be charged after that.", confirm: null });
    expect(vanishLine({ ...live, status: "partially_captured" }, [], null)!.text).toMatch(/^If Pledge-as-Spent disappears today, PayPal ends this hold by 8 Dec 2026/);
  });

  it("once the donor asked PayPal: 'PayPal confirms this date', or PayPal's own date when it differs (must differ)", () => {
    expect(vanishLine(live, [], answer({ paypal: { status: "CREATED", expires: "2026-12-08T04:45:39Z" } }))!.confirm).toBe("PayPal confirms this date.");
    expect(vanishLine(live, [], answer({ expiry: "differs", paypal: { status: "CREATED", expires: "2026-12-09T04:45:39Z" } }))!.confirm).toBe("PayPal’s own date for it: 2026-12-09 04:45:39 UTC.");
    // Another donor's hold, or no answer for this one: nothing is claimed.
    expect(vanishLine(live, [], answer({ id: "OTHER", paypal: { status: "CREATED", expires: "2026-12-08T04:45:39Z" } }))!.confirm).toBeNull();
    expect(vanishLine(live, [], answer({ expiry: null, paypal: { http: 0, status: null, expires: null } }))!.confirm).toBeNull();
  });

  it("no promise it cannot keep: no 'guaranteed', no 'safe'", () => {
    const all = [vanishLine(live, [], null)!.text, vanishLine({ ...live, status: "voided" }, [voidCall(200)], null)!.text];
    for (const t of all) expect(t).not.toMatch(/guarantee|safe|never left/i);
  });

  it("a voided hold: the day PayPal answered the void, from the journal of PayPal calls", () => {
    const voided = { ...live, status: "voided" as const };
    expect(vanishLine(voided, [voidCall(200)], null)).toEqual({ text: "PayPal voided this hold on 9 Nov 2026: nothing more can be charged from it.", confirm: null });
    // A refused void is not a void; with no answered void the day is not claimed.
    expect(vanishLine(voided, [voidCall(422)], null)!.text).toBe("PayPal voided this hold: nothing more can be charged from it.");
    expect(vanishLine(voided, [], answer({ paypal: { status: "VOIDED", updated: "2026-11-09T04:46:49Z" } }))!.confirm).toBe("PayPal confirms: VOIDED, 2026-11-09 04:46:49 UTC.");
  });

  it("an expired hold ends on its day; a void on its way, a fully spent hold, an unapproved one: no line", () => {
    expect(vanishLine({ ...live, status: "expired" }, [], null)!.text).toBe("PayPal ended this hold on 8 Dec 2026: nothing more can be charged from it.");
    expect(vanishLine({ ...live, revoked: true }, [], null)).toBeNull();
    expect(vanishLine({ ...live, status: "captured" }, [], null)).toBeNull();
    expect(vanishLine({ ...live, status: "pending_approval", authorizationId: null }, [], null)).toBeNull();
    expect(vanishLine({ ...live, expiresAt: null }, [], null)).toBeNull();
  });
});
