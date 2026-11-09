import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { holdTag, paypalActivity } from "@/ui/derive";
import { money } from "@/ui/format";
import { countLine } from "@/ui/landing-count";
import { deriveLedger } from "@/ui/ledger/derive";
import type { DriveView, Hold, JournalCall, LedgerRow } from "@/ui/types";

// A pledge is a PayPal hold. What a drive does not spend is never charged: PayPal releases the hold. The words say so
// only where it is true: a share PayPal took and then gave back (a refund) was charged, so its words stay "returned".

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const control = () => (JSON.parse(readFileSync(path.join(__dirname, "../../evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;
const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name)) as Hold;
const rowsOf = (v: DriveView, name: string) => v.ledger.filter((r) => r.kind === "donor_share" && r.donorName?.startsWith(name));

function refund(v: DriveView, row: LedgerRow, amount: number) {
  row.reversed = amount;
  row.status = amount >= (row.amount ?? 0) ? "reversed" : "partly_reversed";
  const h = holdOf(v, row.donorName ?? "");
  h.captured -= amount;
  h.reversed += amount;
}

describe("the Ledger says never charged where PayPal released the hold", () => {
  it("a closed drive: every donor's rest is never charged, and so is the third total, in three languages", () => {
    const en = deriveLedger(fixture("closed"), "en");
    expect(en.donors.map((d) => [d.name, d.neverCharged, d.words?.rest])).toEqual([
      ["Lena", true, "never charged"],
      ["Mark", true, "never charged"],
      ["Yuki", true, "never charged"],
    ]);
    expect(en.restTitle).toBe("Never charged");
    expect(en.donorsTitle).toBe("Rest never charged");
    expect([deriveLedger(fixture("closed"), "de").restTitle, deriveLedger(fixture("closed"), "de").donors[0].words?.rest]).toEqual(["Nie belastet", "nie belastet"]);
    expect([deriveLedger(fixture("closed"), "ja").restTitle, deriveLedger(fixture("closed"), "ja").donors[0].words?.rest]).toEqual(["請求されず", "請求されず"]);
  });

  it("the assistant's words stay as they were: its tools read restLabel and restWord, and its answers were measured on them", () => {
    const m = deriveLedger(fixture("closed"), "en");
    expect(m.restLabel).toBe("Returned to donors");
    expect(m.donors.map((d) => d.restWord)).toEqual(["back", "back", "back"]);
  });

  it("must differ: a share PayPal took and then refunded was charged, so that donor's rest and the total say returned", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Mark")[0];
    refund(v, row, row.amount ?? 0);
    const m = deriveLedger(v, "en");
    const mark = m.donors.find((d) => d.name === "Mark")!;
    expect([mark.neverCharged, mark.words?.rest]).toEqual([false, "back"]);
    expect(m.donors.find((d) => d.name === "Lena")!.neverCharged).toBe(true);
    expect(m.restTitle).toBe("Returned to donors");
    expect(m.donorsTitle).toBe("Back to donors");
  });

  it("a closed drive whose void is still on its way: that hold is not called never charged yet", () => {
    const v = fixture("closed");
    Object.assign(holdOf(v, "Lena"), { status: "authorized", released: 0, available: 1542 });
    const m = deriveLedger(v, "en");
    expect(m.donors.find((d) => d.name === "Lena")!.neverCharged).toBe(false);
    expect(m.restTitle).toBe("Returned to donors");
  });

  it("an open drive: a withdrawn hold PayPal voided is never charged, and the note says so; a refund on a live hold still says returned", () => {
    const v = fixture("open");
    Object.assign(holdOf(v, "Yuki"), { status: "voided", revoked: true, released: holdOf(v, "Yuki").available, available: 0, capacityBase: 0 });
    const m = deriveLedger(v, "en");
    expect(m.restNote).toBe("¥1,763 already released, never charged");
    expect(m.restTitle).toBe("Held");
    expect(m.donorsTitle).toBe("Held for donors");
    expect(m.donors.find((d) => d.name === "Yuki")!.words?.rest).toBe("never charged");
    expect(deriveLedger(v, "de").restNote).toBe("1.763 ¥ schon freigegeben, nie belastet");

    const r = fixture("open");
    const row = rowsOf(r, "Yuki")[0];
    row.status = "captured";
    refund(r, row, 300);
    expect(deriveLedger(r, "en").restNote).toBe(`${money("JPY", 300)} already returned`);
  });
});

describe("the hold's tag and the PayPal journal", () => {
  const tag = (over: Partial<Hold>) => holdTag({ ...holdOf(fixture("open"), "Lena"), ...over });

  it("a voided hold: never charged, rest or all; after a refund: returned, as before", () => {
    expect(tag({ status: "voided", accrued: 0, captured: 458, released: 1542 })).toBe("Rest never charged");
    expect(tag({ status: "voided", accrued: 0, released: 2000 })).toBe("Never charged");
    expect(tag({ status: "voided", accrued: 0, captured: 200, reversed: 258, released: 1542 })).toBe("Rest returned");
    expect(tag({ status: "voided", accrued: 0, captured: 0, reversed: 458, released: 1542 })).toBe("Returned");
  });

  it("the journal names a void PayPal answered VOIDED a release that was never charged; a refused one is only a request", () => {
    const v = fixture("closed");
    const voids = paypalActivity(v).filter((a) => a.key.startsWith("void:"));
    expect(voids.length).toBeGreaterThan(0);
    for (const a of voids) expect(a.parts[0]).toBe("Rest of the hold released, never charged");
    const call = v.paypal.find((c) => c.requestId?.startsWith("void:"))!;
    const refused: JournalCall = { ...call, httpStatus: 422, ids: { issue: "CANNOT_BE_VOIDED" } };
    const w = { ...v, paypal: [refused] };
    expect(paypalActivity(w).map((a) => a.parts[0])).toEqual(["Release of the rest of the hold"]);
  });
});

describe("the landing page's count, from the same derive as the Ledger", () => {
  it("the finished control drive: what donors pledged, what checked lines took, what was never charged", () => {
    const m = deriveLedger(control(), "en");
    expect(m.promised).toBe(m.spent + m.returned);
    expect(countLine(m)).toBe(`On the finished drive, donors pledged ${money("JPY", m.promised)}: ${money("JPY", m.spent)} paid for checked receipt lines, and ${money("JPY", m.returned)} was never charged.`);
  });

  it("no count for a drive that is still open, or where a refund makes 'never charged' untrue", () => {
    expect(countLine(deriveLedger(fixture("open"), "en"))).toBeNull();
    const v = fixture("closed");
    refund(v, rowsOf(v, "Mark")[0], 100);
    expect(countLine(deriveLedger(v, "en"))).toBeNull();
  });
});
