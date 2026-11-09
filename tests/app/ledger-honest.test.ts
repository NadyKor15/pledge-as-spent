import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveLedger } from "@/ui/ledger/derive";
import { planMap } from "@/ui/ledger/layout";
import { LedgerStore } from "@/ui/ledger/store";
import { money } from "@/ui/format";
import type { DriveView, Hold, LedgerRow } from "@/ui/types";

// The Ledger away from the two lucky snapshots: every drive here is one of them with something
// happened to it, the way the book records it.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const yen = (n: number) => money("JPY", n);

const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name)) as Hold;
const rowsOf = (v: DriveView, name: string) => v.ledger.filter((r) => r.kind === "donor_share" && r.donorName?.startsWith(name));
const donorOf = (v: DriveView, name: string) => deriveLedger(v).donors.find((d) => d.name === name)!;

const adds = (m: ReturnType<typeof deriveLedger>) => expect(m.spent + m.held + m.returned, "promised = spent + held + returned").toBe(m.promised);

/** PayPal took a captured share back. */
function reverse(v: DriveView, row: LedgerRow, amount: number) {
  row.reversed = amount;
  row.status = amount >= (row.amount ?? 0) ? "reversed" : "partly_reversed";
  const h = holdOf(v, row.donorName ?? "");
  h.captured -= amount;
  h.reversed += amount;
}

/** A capture was refused for good: the share will never be collected. */
function uncollect(v: DriveView, row: LedgerRow) {
  row.status = "uncollected";
  row.captureId = null;
  const h = holdOf(v, row.donorName ?? "");
  h.uncollected += row.amount ?? 0;
  if (h.accrued > 0) h.accrued -= row.amount ?? 0;
  else h.captured -= row.amount ?? 0;
}

describe("1. the totals follow what really happened to the money", () => {
  it("a reversed share leaves Spent and goes back to the donor", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Mark")[0];
    reverse(v, row, row.amount ?? 0);
    const m = deriveLedger(v);
    expect(yen(m.spent)).toBe(yen(5224 - row.base));
    expect(yen(m.returned)).toBe(yen(5559 + row.base));
    adds(m);
    const mark = m.donors.find((d) => d.name === "Mark")!;
    expect(mark.spentText).toBe(money("USD", 2145 - (row.amount ?? 0)));
    expect(mark.restText).toBe(money("USD", 855 + (row.amount ?? 0)));
  });

  it("a partly reversed share keeps only what stayed", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Lena")[0];
    reverse(v, row, 100);
    const m = deriveLedger(v);
    expect(m.spent).toBe(5224 - 162);
    adds(m);
  });

  it("a share taken back in full leaves nothing, whichever way its two sides were rounded", () => {
    const v = fixture("closed");
    for (const row of rowsOf(v, "Mark")) reverse(v, row, row.amount ?? 0);
    const m = deriveLedger(v);
    expect(m.donors.find((d) => d.name === "Mark")!.spentBase).toBe(0);
    expect(m.spent).toBe(5224 - 3244);
    adds(m);
  });

  it("an uncollected share was never spent", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Lena")[0];
    uncollect(v, row);
    const m = deriveLedger(v);
    expect(m.spent).toBe(5224 - row.base);
    expect(m.returned).toBe(5559 + row.base);
    adds(m);
  });

  it("the company match counts the same way", () => {
    const v = fixture("closed");
    const shares = v.ledger.filter((r) => r.kind === "match_share");
    const [taken, lost] = shares;
    reverse(v, taken, taken.amount ?? 0);
    uncollect(v, lost);
    expect(deriveLedger(v).match).toBe(5224 - taken.base - lost.base);
  });

  it("the shares are worth their base amounts even when a line of the need is someone else's", () => {
    const v = fixture("open");
    v.needs[0].donorBase = 0;
    expect(deriveLedger(v).spent).toBe(5224);
  });
});

describe("2. a hold that ended inside an open drive", () => {
  function withdrawn(v: DriveView, name: string, status: Hold["status"], revoked: boolean) {
    const h = holdOf(v, name);
    Object.assign(h, { status, revoked, released: h.available, available: 0, capacityBase: 0 });
  }

  it("Yuki withdrew: Held drops, what went back is said, and Yuki's row says back", () => {
    const v = fixture("open");
    withdrawn(v, "Yuki", "voided", true);
    const m = deriveLedger(v);
    expect(m.restLabel).toBe("Held");
    expect(yen(m.rest)).toBe("¥3,796");
    expect(m.restNote).toBe("¥1,763 already released, never charged");
    adds(m);
    const yuki = m.donors.find((d) => d.name === "Yuki")!;
    expect([yuki.restText, yuki.restWord]).toEqual(["¥1,763", "back"]);
    expect(m.donors.find((d) => d.name === "Mark")!.restWord).toBe("held");
  });

  it("an expired hold is not held", () => {
    const v = fixture("open");
    withdrawn(v, "Mark", "expired", false);
    const m = deriveLedger(v);
    expect(m.held).toBe(2504 + 1763);
    expect(m.returned).toBe(1292);
    adds(m);
  });

  it("a blocked hold waits for its void: the money is still held, the lost share is not spent", () => {
    const v = fixture("open");
    const h = holdOf(v, "Lena");
    Object.assign(h, { blocked: true, blockedReason: "refused", available: 0 });
    const row = rowsOf(v, "Lena")[0];
    uncollect(v, row);
    const m = deriveLedger(v);
    expect(m.spent).toBe(5224 - row.base);
    expect(m.returned).toBe(0);
    adds(m);
    expect(donorOf(v, "Lena").restWord).toBe("held");
  });

  it("a refund on a live hold went back to the donor: it is not held", () => {
    const v = fixture("open");
    const row = rowsOf(v, "Yuki")[0];
    row.status = "captured";
    reverse(v, row, 300);
    const m = deriveLedger(v);
    expect(yen(m.held)).toBe(yen(5559));
    expect(yen(m.returned)).toBe(yen(300));
    expect(m.restNote).toBe(`${yen(300)} already returned`);
    expect(m.donors.find((d) => d.name === "Yuki")!.restWord).toBe("held");
    expect(m.donors.find((d) => d.name === "Yuki")!.restText).toBe(yen(1763));
    adds(m);
  });

  it("nothing has gone back: no note", () => {
    expect(deriveLedger(fixture("open")).restNote).toBeNull();
  });

  it("a closed drive says Returned and needs no note, even with a hold that never voided", () => {
    const v = fixture("closed");
    Object.assign(holdOf(v, "Lena"), { status: "authorized", released: 0, available: 1542 });
    const m = deriveLedger(v);
    expect(m.restLabel).toBe("Returned to donors");
    expect(m.restNote).toBeNull();
    expect(m.held).toBe(0);
    adds(m);
  });

  it("a closing drive is still Held", () => {
    const v = fixture("open");
    v.drive.status = "closing";
    const m = deriveLedger(v);
    expect(m.restLabel).toBe("Held");
    expect(yen(m.rest)).toBe("¥5,559");
    adds(m);
  });
});

describe("rounding, as the core rounds", () => {
  it("€20.01 spent to the last cent leaves nothing to return", () => {
    const v = fixture("closed");
    const h = holdOf(v, "Lena");
    Object.assign(h, { pledged: 2001, authorized: 2001, captured: 2001, released: 0 });
    const rows = rowsOf(v, "Lena");
    rows.forEach((r, i) => {
      r.base = i === 0 ? 3248 : 0;
      r.amount = i === 0 ? 2001 : 0;
    });
    const lena = deriveLedger(v).donors.find((d) => d.name === "Lena")!;
    expect(lena.restBase).toBe(0);
    expect(lena.restText).toBe("€0.00");
    const m = deriveLedger(v);
    expect(m.returned).toBe(5559 - 2504);
    adds(m);
  });

  it("the promise is the floor of the hold, not the nearest yen", () => {
    const v = fixture("open");
    Object.assign(holdOf(v, "Lena"), { authorized: 2001 });
    expect(deriveLedger(v).promised).toBe(10783 - 3247 + 3248);
  });
});

describe("the note under Spent", () => {
  it("says how much waits for the capture, in the screens' own words", () => {
    expect(deriveLedger(fixture("open")).waitingNote).toBe("¥5,224 waiting for the daily capture");
  });

  it("names the batch rhythm the drive really has", () => {
    const v = fixture("open");
    v.drive.batch = { ...v.drive.batch, maxAgeHours: 6 };
    expect(deriveLedger(v).waitingNote).toBe("¥5,224 waiting for the next capture");
  });

  it("a share on its way to PayPal still waits", () => {
    const v = fixture("open");
    rowsOf(v, "Mark").forEach((r) => (r.status = "capture_pending"));
    expect(deriveLedger(v).waitingNote).toBe("¥5,224 waiting for the daily capture");
  });

  it("only what still waits is counted", () => {
    const v = fixture("open");
    rowsOf(v, "Mark").forEach((r) => (r.status = "captured"));
    expect(deriveLedger(v).waitingNote).toBe(`${yen(5224 - 3244)} waiting for the daily capture`);
  });

  it("a closed drive and a drive with nothing waiting say nothing", () => {
    expect(deriveLedger(fixture("closed")).waitingNote).toBeNull();
    const v = fixture("open");
    v.ledger = [];
    expect(deriveLedger(v).waitingNote).toBeNull();
  });
});

describe("3. Charged says what PayPal took", () => {
  const charged = (v: DriveView, key: string) => deriveLedger(v).book.find((r) => r.lineKey === key && r.payer !== "Kitasora Logistics")?.charged;

  it("nothing yet on a recorded share or one on its way", () => {
    const v = fixture("open");
    expect(deriveLedger(v).book.filter((r) => r.need !== "Refused").every((r) => r.charged === "—")).toBe(true);
    const row = rowsOf(v, "Lena")[0];
    row.status = "capture_pending";
    expect(charged(v, `${row.receiptId}:${row.lineNo}`)).toBe("—");
  });

  it("the captured amount less what came back", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Lena")[0];
    reverse(v, row, 100);
    expect(charged(v, `${row.receiptId}:${row.lineNo}`)).toBe("€1.46");
  });

  it("a dash on an uncollected share", () => {
    const v = fixture("closed");
    const row = rowsOf(v, "Lena")[0];
    uncollect(v, row);
    expect(charged(v, `${row.receiptId}:${row.lineNo}`)).toBe("—");
  });
});

describe("4. a drive with no receipts", () => {
  const empty = () => {
    const v = fixture("open");
    v.ledger = [];
    v.receipts = [];
    v.holds.forEach((h) => Object.assign(h, { accrued: 0, available: h.authorized }));
    return v;
  };

  it("nothing flowed, so nothing is drawn as a flow", () => {
    const plan = planMap(deriveLedger(empty()).donors, { width: 960, height: 560, compact: false });
    expect(plan.placed).toHaveLength(3);
    for (const p of plan.placed) {
      expect(p.arcs).toEqual([]);
      expect(p.pills.map((x) => x.flow)).toEqual(["held"]);
    }
    expect(JSON.stringify(plan.placed.map((p) => p.pills))).not.toMatch(/[€$¥]0(\.00)?\b/);
  });

  it("the totals say the same", () => {
    const m = deriveLedger(empty());
    expect(m.spent).toBe(0);
    expect(m.held).toBe(10783);
    expect(m.match).toBe(0);
    adds(m);
  });
});

describe("two receipts, one of them private", () => {
  const two = (publishedSecond: boolean, publishedFirst = true) => {
    const v = fixture("closed");
    const [first] = v.receipts;
    const second = { ...first, id: `${first.id}b`, image: publishedSecond ? { ...first.image, url: "/api/receipts/second/image" } : { published: false as const, note: "Could not hide the details." } };
    v.receipts = [publishedFirst ? first : { ...first, image: { published: false as const, note: "Could not hide the details." } }, second as (typeof v.receipts)[number]];
    return v;
  };

  it("the photo offered is one that was published", () => {
    expect(deriveLedger(two(true)).receiptUrl).toBe("/api/receipts/second/image");
    expect(deriveLedger(two(false)).receiptUrl).toBe(`/api/receipts/${fixture("closed").receipts[0].id}/image`);
    expect(deriveLedger(two(false, false)).receiptUrl).toBeNull();
  });
});

describe("7. a need's filter keeps its refused and unfunded lines", () => {
  it("a line refused because the need was covered, and one left unfunded, stay under that need", () => {
    const v = fixture("closed");
    const base = { at: "2026-11-01T02:06:01.717Z", receiptId: v.receipts[0].id, item: "Drinking water 2 L", qty: 1, pledgeId: null, donorName: null, baseCurrency: "JPY", currency: null, amount: null, matchBase: 0, captureId: null, reversed: null, honored: null } as const;
    v.ledger.push(
      { ...base, rowId: "x/need_covered", lineNo: 21, needId: "water", kind: "rejected", base: 100, status: "rejected", code: "need_covered", reasonEn: "only some" } as LedgerRow,
      { ...base, rowId: "x/unfunded", lineNo: 22, needId: "water", kind: "unfunded", base: 90, status: "unfunded", code: "not_enough_pledges", reasonEn: "not enough" } as LedgerRow,
    );
    const m = deriveLedger(v);
    const water = m.needs.find((n) => n.needId === "water")!;
    expect(water.lineKeys).toContain(`${v.receipts[0].id}:21`);
    expect(water.lineKeys).toContain(`${v.receipts[0].id}:22`);
    expect(m.book.filter((r) => water.lineKeys.includes(r.lineKey)).map((r) => r.status)).toEqual(expect.arrayContaining(["Refused", "Unfunded"]));
  });
});

describe("9. the filter follows new lines", () => {
  it("a re-read that brings more lines for the selected need reaches the book", () => {
    const v = fixture("closed");
    const store = new LedgerStore(deriveLedger(v));
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    store.toggle({ kind: "need", needId: "water" });
    const more = fixture("closed");
    more.ledger.push({ ...rowsOf(more, "Lena")[0], rowId: "more", lineNo: 30 });
    store.setModel(deriveLedger(more));
    expect(seen.at(-1)).toContain(`${v.receipts[0].id}:30`);
  });

  it("a re-read with the same lines does not touch the filter", () => {
    const v = fixture("closed");
    const store = new LedgerStore(deriveLedger(v));
    const seen: string[][] = [];
    store.connectFilter((keys) => seen.push(keys));
    store.toggle({ kind: "need", needId: "water" });
    const count = seen.length;
    store.setModel(deriveLedger(fixture("closed")));
    expect(seen).toHaveLength(count);
  });
});

describe("the invariant, on every state a donor can be in", () => {
  const status = fc.constantFrom("accrued", "capture_pending", "captured", "partly_reversed", "reversed", "uncollected");
  const share = fc.record({ base: fc.integer({ min: 1, max: 900 }), amount: fc.integer({ min: 1, max: 900 }), status, reversedPart: fc.double({ min: 0, max: 1, noNaN: true }) });
  const donor = fc.record({
    currency: fc.constantFrom("JPY", "USD", "EUR"),
    rate: fc.constantFrom("162.35", "151.20", "149.87", "0.0123"),
    authorized: fc.integer({ min: 1, max: 900_000 }),
    holdStatus: fc.constantFrom("authorized", "partially_captured", "captured", "voided", "expired"),
    shares: fc.array(share, { maxLength: 5 }),
  });

  it("promised = spent + held + returned, exactly, in the same minor units", () => {
    fc.assert(
      fc.property(fc.array(donor, { minLength: 1, maxLength: 6 }), fc.constantFrom("open", "closing", "closed"), (donors, driveStatus) => {
        const v = fixture("open");
        const template = v.ledger[0];
        const holdTemplate = v.holds[0];
        v.drive.status = driveStatus as DriveView["drive"]["status"];
        v.closeReport = [];
        v.ledger = [];
        v.holds = donors.map((d, i) => {
          const pledgeId = `p${i}`;
          const fx = { ...holdTemplate.fx, base: "JPY", quote: d.currency, rate: d.currency === "JPY" ? "1" : d.rate };
          d.shares.forEach((s, j) => {
            const reversed = s.status === "reversed" ? s.amount : s.status === "partly_reversed" ? Math.floor(s.amount * s.reversedPart) : 0;
            v.ledger.push({ ...template, rowId: `${i}/${j}`, lineNo: i * 10 + j, needId: "water", pledgeId, donorName: `D${i}`, currency: d.currency, amount: s.amount, base: s.base, status: s.status, reversed } as LedgerRow);
          });
          return { ...holdTemplate, pledgeId, kind: "donor", donorName: `D${i}`, currency: d.currency, authorized: d.authorized, pledged: d.authorized, status: d.holdStatus, fx } as Hold;
        });
        const m = deriveLedger(v);
        expect(m.spent + m.held + m.returned).toBe(m.promised);
        // The word "spent" on the screens is `captured`: pledged = spent + waiting + held + returned.
        expect(m.captured + m.waiting + m.held + m.returned).toBe(m.promised);
        expect(m.captured).toBeGreaterThanOrEqual(0);
        expect(m.waiting).toBeGreaterThanOrEqual(0);
        if (driveStatus === "closed") expect(m.waiting).toBe(0);
        for (const d of m.donors) expect(d.waiting).toBeLessThanOrEqual(d.spent);
        expect(m.spent).toBeGreaterThanOrEqual(0);
        expect(m.held).toBeGreaterThanOrEqual(0);
        expect(m.returned).toBeGreaterThanOrEqual(0);
        if (driveStatus === "closed") expect(m.held).toBe(0);
        else expect(m.rest).toBe(m.held);
      }),
      { numRuns: 300 },
    );
  });
});
