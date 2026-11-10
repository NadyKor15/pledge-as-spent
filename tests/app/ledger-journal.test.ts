import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLedger } from "@/ui/ledger/derive";
import { journalOf, pledgeOfKey } from "@/ui/ledger/journal";
import { JOURNAL_ROWS, ledgerState, RECEIPT_ROWS, type Metrics } from "@/ui/ledger/studio-state";
import { PANEL_WORDS } from "@/ui/ledger/words-panels";
import { SHOWCASE_DRIVE_ID } from "@/ui/showcase";
import type { DriveView } from "@/ui/types";

// T3, the PayPal journal on the Ledger: every PayPal call of the drive with PayPal's own word, grouped as the money
// moved; a donor's row presses that donor; "Recorded" on a finished drive or the showcase, "Live" only on an open one.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const closed = fixture("closed");
const open = fixture("open");
/** The closed drive's journal (en, de, ja) as the code before renewals were read wrote it (207c7f1). */
const CLOSED_JOURNAL_SHA256 = "fffa877cef82f8101b4013f14b2e75eb82ed40ca3a0c25c7babd92790b936d7f";

describe("the pledge a PayPal call acted on", () => {
  it("is read from the call's key, whatever the kind", () => {
    expect(pledgeOfKey("hold:demo-x.water")).toBe("demo-x.water");
    expect(pledgeOfKey("order:demo-x.water")).toBe("demo-x.water");
    expect(pledgeOfKey("authorize:demo-x.water")).toBe("demo-x.water");
    expect(pledgeOfKey("cap:demo-x:demo-x.water:2")).toBe("demo-x.water");
    expect(pledgeOfKey("void:demo-x:demo-x.water")).toBe("demo-x.water");
    expect(pledgeOfKey("reauth:demo-x:demo-x.water")).toBe("demo-x.water");
    expect(pledgeOfKey("pay:demo-x:demo-x.r1")).toBeNull();
    expect(pledgeOfKey("receipt:demo-x.r1")).toBeNull();
  });
});

describe("the journal of a finished drive", () => {
  const j = journalOf(closed, deriveLedger(closed));
  const byGroup = Object.fromEntries(j.groups.map((g) => [g.id, g]));

  it("four groups as the money moved: holds, receipt and payout, charged, never charged", () => {
    expect(j.groups.map((g) => g.title)).toEqual(["Holds placed", "Receipt and payout", "Charged", "Never charged"]);
    expect(byGroup.holds.events.map((e) => e.who)).toEqual(["Lena", "Mark", "Yuki", "Kitasora Logistics"]);
    expect(byGroup.payout.events.map((e) => e.kind)).toEqual(["receipt", "pay"]);
    expect(byGroup.charged.events).toHaveLength(4);
    expect(byGroup.never.events.map((e) => e.text)).toEqual(["Lena · rest never charged", "Mark · rest never charged", "Yuki · rest never charged", "Kitasora Logistics · rest never charged"]);
    expect(j.events).toHaveLength(14);
  });

  it("PayPal's status is PayPal's, untranslated", () => {
    expect(byGroup.never.events.map((e) => e.status)).toEqual(["VOIDED", "VOIDED", "VOIDED", "VOIDED"]);
    expect(byGroup.charged.events.every((e) => e.status === "COMPLETED")).toBe(true);
    expect(byGroup.payout.events[0].status).toBeNull();
  });

  it("only a donor's rows press anyone: not the match, the payout or the receipt", () => {
    const pressing = j.events.filter((e) => e.donor);
    expect(new Set(pressing.map((e) => e.who))).toEqual(new Set(["Lena", "Mark", "Yuki"]));
    expect(j.events.filter((e) => e.who === "Kitasora Logistics").every((e) => !e.donor)).toBe(true);
    expect(j.events.filter((e) => e.kind === "pay" || e.kind === "receipt").every((e) => !e.donor && e.pledgeId === null)).toBe(true);
    const lena = deriveLedger(closed).donors.find((d) => d.name === "Lena")!;
    expect(byGroup.never.events[0].pledgeId).toBe(lena.pledgeId);
  });

  it("times are UTC, to the second, oldest first", () => {
    for (const e of j.events) expect(e.time).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(j.events.map((e) => e.at)).toEqual([...j.events.map((e) => e.at)].sort());
  });

  it("says Recorded on a finished drive", () => {
    expect(j.recorded).toBe(true);
  });

  it("in German and Japanese, with the never-charged words of the screen", () => {
    const de = journalOf(closed, deriveLedger(closed, "de"), "de");
    const ja = journalOf(closed, deriveLedger(closed, "ja"), "ja");
    expect(de.groups.map((g) => g.title)).toEqual(["Reservierungen", "Beleg und Auszahlung", "Belastet", "Nie belastet"]);
    expect(de.events.find((e) => e.kind === "void")!.text).toBe("Lena · Rest nie belastet");
    expect(ja.events.find((e) => e.kind === "void")!.text).toBe("Lena · 残りは請求されず");
    expect(ja.groups[3].title).toBe("請求されず");
    expect(de.events.find((e) => e.kind === "hold")!.text).toMatch(/^Lena · Reservierung · 20,00\s€$/);
  });
});

describe("the journal of an open drive", () => {
  it("says Live, unless it is the showcase", () => {
    expect(journalOf(open, deriveLedger(open)).recorded).toBe(false);
    const shown = structuredClone(open);
    shown.drive.id = SHOWCASE_DRIVE_ID;
    expect(journalOf(shown, deriveLedger(shown)).recorded).toBe(true);
  });

  it("no release yet: the never-charged group is empty and keeps its title", () => {
    const j = journalOf(open, deriveLedger(open));
    expect(j.groups[3]).toMatchObject({ title: "Never charged", events: [] });
  });
});

describe("a release PayPal has not confirmed, and one after a refund", () => {
  it("a release without VOIDED is a request, not 'never charged'; no answer is said in the reader's words", () => {
    const v = structuredClone(closed);
    const call = v.paypal.find((c) => c.requestId?.startsWith("void:") && c.requestId.endsWith(".water"))!;
    call.httpStatus = 0;
    const j = journalOf(v, deriveLedger(v));
    const lena = j.events.find((e) => e.kind === "void" && e.who === "Lena")!;
    expect(lena).toMatchObject({ text: "Lena · release of the rest asked", status: "NO ANSWER", never: false, ok: false });
    expect(j.groups[3].title).toBe("Released");
    expect(journalOf(v, deriveLedger(v, "ja"), "ja").events.find((e) => e.key === lena.key)!.status).toBe("応答なし");
  });

  it("VOIDED after a refund: released, never 'never charged'", () => {
    const v = structuredClone(closed);
    v.holds.find((h) => h.pledgeId.endsWith(".water"))!.reversed = 100;
    const j = journalOf(v, deriveLedger(v));
    expect(j.events.find((e) => e.kind === "void" && e.who === "Lena")!.text).toBe("Lena · rest released");
    expect(j.groups[3].title).toBe("Released");
  });
});

// RENEW (P3FL): Lena's hold was renewed. The old hold is voided with `renewedTo`; its rest carries on to the new hold, so
// nothing of it is "never charged"; the new hold's rows press Lena like her first hold's. A hand-made fixture on the closed
// drive (the renewal fields read structurally: the Hold type of this branch does not carry them).
describe("the journal of a renewed pledge", () => {
  const OLD = "demo-f372326129.water";
  const NEW = `${OLD}.r1`;
  function renewed(): DriveView {
    const v = structuredClone(closed);
    const old = v.holds.find((h) => h.pledgeId === OLD)!;
    Object.assign(old, { renewedTo: NEW, released: 1542 });
    v.holds.push({ ...structuredClone(old), pledgeId: NEW, status: "authorized", authorized: 1542, captured: 0, released: 0, authorizationId: "9RENEW00000000001", renewedTo: undefined, renews: OLD, usable: 1542 } as DriveView["holds"][number]);
    const cap = v.paypal.find((c) => c.requestId === `cap:demo-f372326129:${OLD}:1`)!;
    v.paypal.push({ ...structuredClone(cap), id: 9001, ts: "2026-11-02T02:06:03.232Z", path: "/v2/payments/authorizations/9RENEW00000000001/capture", requestId: `cap:demo-f372326129:${NEW}:1`, ids: { ...cap.ids, id: "9RENEWCAP0000001", invoiceId: `cap:demo-f372326129:${NEW}:1` } });
    return v;
  }
  const v = renewed();
  const j = journalOf(v, deriveLedger(v));
  const byGroup = Object.fromEntries(j.groups.map((g) => [g.id, g]));
  const lenaVoid = j.events.find((e) => e.key === `void:demo-f372326129:${OLD}`)!;

  it("the old hold's void: the rest carried on to a new hold, never 'never charged', with the holds", () => {
    expect(lenaVoid).toMatchObject({ text: "Lena · rest carried on to a new hold", status: "VOIDED", never: false, group: "holds" });
    expect(byGroup.holds.events).toContain(lenaVoid);
    expect(byGroup.never.events.map((e) => e.text)).toEqual(["Mark · rest never charged", "Yuki · rest never charged", "Kitasora Logistics · rest never charged"]);
    expect(byGroup.never.title).toBe("Never charged");
  });

  it("the new hold's rows press Lena: their pledge is her first hold's", () => {
    const lena = deriveLedger(v).donors.find((d) => d.name === "Lena")!;
    expect(lena.pledgeId).toBe(OLD);
    const capNew = j.events.find((e) => e.key === `cap:demo-f372326129:${NEW}:1`)!;
    expect(capNew).toMatchObject({ pledgeId: OLD, donor: true, who: "Lena", group: "charged" });
    expect(lenaVoid).toMatchObject({ pledgeId: OLD, donor: true });
  });

  it("in German and Japanese", () => {
    const de = journalOf(v, deriveLedger(v, "de"), "de");
    const ja = journalOf(v, deriveLedger(v, "ja"), "ja");
    expect(de.events.find((e) => e.key === lenaVoid.key)!.text).toBe("Lena · Rest auf neue Reservierung übertragen");
    expect(ja.events.find((e) => e.key === lenaVoid.key)!.text).toBe("Lena · 残りを新しい保留へ引き継ぎ");
    expect(de.groups[3].title).toBe("Nie belastet");
  });

  it("without a renewal, the journal is as it was: each row names its own hold, the same words and groups", () => {
    for (const drive of [closed, open])
      for (const lang of ["en", "de", "ja"] as const) {
        const plain = journalOf(drive, deriveLedger(drive, lang), lang);
        for (const e of plain.events) expect(e.pledgeId).toBe(pledgeOfKey(e.key));
        expect(plain.events.filter((e) => e.kind === "void").every((e) => e.group === "never")).toBe(true);
      }
    // Byte for byte: the closed drive's whole journal in three languages hashes as it did before renewals were read (207c7f1).
    const bytes = (["en", "de", "ja"] as const).map((lang) => JSON.stringify(journalOf(closed, deriveLedger(closed, lang), lang))).join("\n");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(CLOSED_JOURNAL_SHA256);
  });
});

describe("where the journal sits", () => {
  const metrics = (stacked: boolean): Metrics => ({
    rowHeight: 10,
    stacked,
    scale: 1,
    beside: !stacked,
    rows: { kpi: 19, pair: stacked ? 9 : 0, match: 4, note: 0, map: 56, shelter: 56, donors: stacked ? 30 : 0, footer: 9, journal: stacked ? JOURNAL_ROWS.phone : JOURNAL_ROWS.desktop, ask: 46, receipt: stacked ? RECEIPT_ROWS.phone : RECEIPT_ROWS.beside, head: 6, book: 120 },
  });
  type Box = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };
  const layout = (v: DriveView, m: Metrics) => ledgerState(deriveLedger(v), m).pages[0].widgetLayout! as Record<string, Box>;
  const end = (b: Box) => b.yTrack + b.ySpan;

  it("on a desktop: right under the bottom line, the whole width, before the chat and the book", () => {
    const l = layout(closed, metrics(false));
    expect(l.journal).toMatchObject({ xTrack: 0, xSpan: 48, yTrack: end(l.footer), ySpan: JOURNAL_ROWS.desktop });
    expect(l.ask.yTrack).toBe(end(l.journal));
  });

  it("on a phone: after the chat, before the receipt and the book", () => {
    const l = layout(closed, metrics(true));
    expect(l.journal).toMatchObject({ xTrack: 0, xSpan: 48, yTrack: end(l.ask), ySpan: JOURNAL_ROWS.phone });
    expect(l.receipt.yTrack).toBe(end(l.journal));
    expect(l["book-head"].yTrack).toBe(end(l.receipt));
  });

  it("its height does not depend on how many calls the drive made", () => {
    for (const stacked of [false, true]) expect(layout(open, metrics(stacked)).journal.ySpan).toBe(layout(closed, metrics(stacked)).journal.ySpan);
  });
});

describe("the journal's words", () => {
  const shape = (o: object): string[] =>
    Object.entries(o)
      .flatMap(([k, v]) => (v && typeof v === "object" ? shape(v).map((x) => `${k}.${x}`) : [k]))
      .sort();

  it("every key in every language, none empty", () => {
    const keys = shape(PANEL_WORDS.en);
    expect(keys).toContain("journal.groups.never");
    for (const lang of ["de", "ja"] as const) expect(shape(PANEL_WORDS[lang])).toEqual(keys);
    const leaves = (o: object): unknown[] => Object.values(o).flatMap((v) => (v && typeof v === "object" ? leaves(v) : [v]));
    for (const lang of ["en", "de", "ja"] as const)
      for (const v of leaves(PANEL_WORDS[lang])) expect(typeof v === "function" ? (v as (...a: unknown[]) => string)("X", "Y").length : (v as string).length).toBeGreaterThan(0);
  });
});
