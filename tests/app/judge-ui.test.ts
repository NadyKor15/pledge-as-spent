import { describe, expect, it } from "vitest";
import type { CheckRow } from "../../src/server/paypal-check";
import { floridaDemoOn, FLORIDA_SCENARIO } from "../../src/ui/demo-flags";
import { endLine, rowsFor, utc } from "../../src/ui/paypal-check/rows";
import { CHECK_WORDS } from "../../src/ui/paypal-check/words";
import { shelterPhotoOf } from "../../src/ui/shelter-photo-of";

// The small parts of the judge's tools on screen: the Florida switch, the shelter photo rule, the check's rows and words.

describe("the Florida drive on the landing page", () => {
  it("is offered only when the deployment says on", () => {
    expect([undefined, "", "off", "yes", "1", "true"].map(floridaDemoOn)).toEqual([false, false, false, false, false, false]);
    expect(["on", "ON", " on "].map(floridaDemoOn)).toEqual([true, true, true]);
    expect(FLORIDA_SCENARIO).toBe("florida");
  });
});

describe("the shelter's photo", () => {
  it("absent or named kitasora: the bundled Kitasora photo; null: a plain plate; a path of this app: that picture; anything else: the plate", () => {
    expect(shelterPhotoOf({ id: "d" })).toEqual({ kind: "default" });
    expect(shelterPhotoOf({ shelterPhoto: undefined })).toEqual({ kind: "default" });
    expect(shelterPhotoOf({ shelterPhoto: "kitasora" })).toEqual({ kind: "default" });
    expect(shelterPhotoOf({ shelterPhoto: "florida" })).toEqual({ kind: "none" });
    expect(shelterPhotoOf({ shelterPhoto: null })).toEqual({ kind: "none" });
    expect(shelterPhotoOf({ shelterPhoto: "/scenarios/florida-shelter.jpg" })).toEqual({ kind: "url", src: "/scenarios/florida-shelter.jpg" });
    for (const bad of ["https://example.com/x.png", "//example.com/x.png", "/../secret.png", "/x.svg", "", 42, {}]) expect(shelterPhotoOf({ shelterPhoto: bad })).toEqual({ kind: "none" });
  });
});

const row = (kind: CheckRow["kind"], id: string, pledgeId: string | null, receiptId: string | null) => ({ kind, id, pledgeId, receiptId }) as CheckRow;

describe("Ask PayPal yourself on screen", () => {
  it("a donor's statement shows their hold, its captures and the payouts their money went to", () => {
    const rows = [row("authorization", "A1", "d.water", null), row("capture", "C1", "d.water", null), row("authorization", "A2", "d.diapers", null), row("capture", "C2", "d.diapers", null), row("payout", "P1", null, "d.r1"), row("payout", "P2", null, "d.r2")];
    expect(rowsFor(rows, { pledgeId: "d.water", receiptIds: ["d.r1"] }).map((r) => r.id)).toEqual(["A1", "C1", "P1"]);
    expect(rowsFor(rows).map((r) => r.id)).toEqual(["A1", "C1", "A2", "C2", "P1", "P2"]);
  });

  it("PayPal's times in UTC, its local offsets too", () => {
    expect(utc("2026-11-01T02:06:20Z")).toBe("2026-11-01 02:06:20 UTC");
    expect(utc("2026-10-23T08:49:46-07:00")).toBe("2026-10-23 15:49:46 UTC");
    expect(utc(null)).toBe("–");
  });

  it("German and Japanese say everything English says, and every state the book can report has a word", () => {
    const keys = (o: object) => Object.keys(o).sort();
    for (const lang of ["de", "ja"] as const) {
      expect(keys(CHECK_WORDS[lang])).toEqual(keys(CHECK_WORDS.en));
      expect(keys(CHECK_WORDS[lang].state)).toEqual(keys(CHECK_WORDS.en.state));
      expect(keys(CHECK_WORDS[lang].verdict)).toEqual(keys(CHECK_WORDS.en.verdict));
    }
    for (const state of ["held", "partly_captured", "captured", "voided", "expired", "denied", "reauthorized", "confirmed", "pending", "failed", "reversed"]) expect(CHECK_WORDS.en.state[state]).toBeTruthy();
    expect(CHECK_WORDS.en.answered(9, 9)).toBe("9 of 9 objects answered by PayPal");
  });
});

describe("the day PayPal ends a hold, in the check's table", () => {
  const hold = (status: string, paypalEnds: string | null, bookEnds: string | null, expiry: CheckRow["expiry"]) =>
    ({ kind: "authorization", id: "A1", pledgeId: "d.water", receiptId: null, paypal: { http: 200, status, expires: paypalEnds }, book: { expires: bookEnds }, expiry }) as unknown as CheckRow;

  it("a live hold: PayPal ends it by its date, and our book says the same", () => {
    const line = endLine(hold("CREATED", "2026-12-08T04:45:39Z", "2026-12-08T04:45:39.000Z", "agrees"), "en")!;
    expect(line).toEqual({ says: "PayPal ends this hold by 2026-12-08 04:45:39 UTC", book: "our book: the same date", verdict: "agrees" });
    expect(endLine(hold("PARTIALLY_CAPTURED", "2026-12-08T04:45:39Z", "2026-12-08T04:45:39.000Z", "agrees"), "en")!.says).toMatch(/^PayPal ends this hold by /);
  });

  it("an ended hold keeps its date as PayPal's end date, not as a promise", () => {
    const line = endLine(hold("VOIDED", "2026-12-08T04:45:39Z", "2026-12-08T04:45:39.000Z", "agrees"), "en")!;
    expect(line.says).toBe("End date PayPal set for this hold: 2026-12-08 04:45:39 UTC");
  });

  it("must differ: a book date that is not PayPal's is printed beside it, marked", () => {
    const line = endLine(hold("CREATED", "2026-12-09T04:45:39Z", "2026-12-08T04:45:39.000Z", "differs"), "en")!;
    expect(line).toEqual({ says: "PayPal ends this hold by 2026-12-09 04:45:39 UTC", book: "our book: 2026-12-08 04:45:39 UTC", verdict: "differs" });
  });

  it("no line without PayPal's date, and none for captures or payouts", () => {
    expect(endLine(hold("CREATED", null, "2026-12-08T04:45:39.000Z", null), "en")).toBeNull();
    expect(endLine({ ...hold("COMPLETED", null, null, null), kind: "capture" } as CheckRow, "en")).toBeNull();
    // PayPal's date without one in the book: shown, with no verdict.
    expect(endLine(hold("CREATED", "2026-12-08T04:45:39Z", null, null), "en")).toEqual({ says: "PayPal ends this hold by 2026-12-08 04:45:39 UTC", book: null, verdict: null });
  });

  it("German and Japanese say the same, with the date as data", () => {
    const live = hold("CREATED", "2026-12-08T04:45:39Z", "2026-12-08T04:45:39.000Z", "agrees");
    expect(endLine(live, "de")).toEqual({ says: "PayPal beendet diese Reservierung spätestens am 2026-12-08 04:45:39 UTC", book: "unser Buch: dasselbe Datum", verdict: "agrees" });
    expect(endLine(live, "ja")).toEqual({ says: "PayPal はこの保留を 2026-12-08 04:45:39 UTC までに終了します", book: "帳簿も同じ日付", verdict: "agrees" });
    expect(endLine(hold("VOIDED", "2026-12-08T04:45:39Z", null, null), "de")!.says).toBe("Von PayPal gesetztes Enddatum dieser Reservierung: 2026-12-08 04:45:39 UTC");
    expect(endLine(hold("VOIDED", "2026-12-08T04:45:39Z", null, null), "ja")!.says).toBe("PayPal が定めたこの保留の終了日: 2026-12-08 04:45:39 UTC");
  });
});

