import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { project, locate } from "@/ui/ledger/geo";
import { deriveLedger, shelterName } from "@/ui/ledger/derive";
import { money } from "@/ui/format";
import type { DriveView } from "@/ui/types";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const yen = (n: number) => money("JPY", n);

describe.each(["closed", "open"])("the Ledger of the %s drive", (name) => {
  const view = fixture(name);
  const m = deriveLedger(view);

  it("adds up the three totals and the company match", () => {
    expect(yen(m.promised)).toBe("¥10,783");
    expect(yen(m.spent)).toBe("¥5,224");
    expect(yen(m.rest)).toBe("¥5,559");
    expect(yen(m.match)).toBe("¥5,224");
    expect(m.matchName).toBe("Kitasora Logistics");
  });

  it("names the shelter and what was bought", () => {
    expect(m.shelter).toBe("Kitasora Shelter");
    expect(m.needs.map((n) => [n.label, n.count, n.percent])).toEqual([
      ["Water 2 L", "12 of 40 bottles", 30],
      ["Diapers size M", "6 of 6 packs", 100],
      ["AA batteries", "50 of 50", 100],
    ]);
  });

  it("gives each donor what they spent and pairs them with what they paid for", () => {
    const pairs = m.donors.map((d) => [d.label, d.spentText, d.restText, d.needIds]);
    expect(pairs).toEqual([
      ["Lena · Berlin", "€4.58", "€15.42", ["water"]],
      ["Mark · Columbus", "$21.45", "$8.55", ["diapers"]],
      ["Yuki · Osaka", "¥1,237", "¥1,763", ["batteries"]],
    ]);
    for (const n of m.needs) {
      const donor = m.donors.find((d) => d.needIds.includes(n.needId));
      expect(n.pledgeIds).toEqual([donor?.pledgeId]);
    }
  });

  it("names the refused lines with their amounts", () => {
    expect(m.refused.map((r) => [r.name, r.amount])).toEqual([
      ["Alcohol", "¥1,198"],
      ["Gift card", "¥3,000"],
    ]);
  });

  it("keeps every line of the book, grouped by need, refused lines last", () => {
    expect(m.book).toHaveLength(20);
    expect(m.book.map((r) => r.order)).toEqual(m.book.map((_, i) => i));
    const needs = [...new Set(m.book.map((r) => r.need))];
    expect(needs).toEqual(["Water 2 L", "Diapers size M", "AA batteries", "Refused"]);
    const water = m.book.filter((r) => r.need === "Water 2 L");
    expect(water.map((r) => r.payer)).toEqual(["Lena", "Kitasora Logistics", "Lena", "Kitasora Logistics", "Lena", "Kitasora Logistics"]);
    expect(water[0]).toMatchObject({ line: 1, item: "Natural water from Kitasora 2L", share: 399, charged: "€2.46" });
    expect(m.book.filter((r) => r.need === "Refused").map((r) => [r.item, yen(r.share), r.charged, r.status])).toEqual([
      ["Alcohol", "¥1,198", "—", "Rejected"],
      ["Gift card", "¥3,000", "—", "Rejected"],
    ]);
  });

  it("the shares of the donors add up to what the needs say was spent", () => {
    const shares = m.book.filter((r) => r.need !== "Refused" && r.payer !== "Kitasora Logistics").reduce((sum, r) => sum + r.share, 0);
    expect(shares).toBe(m.spent);
  });

  it("offers the published receipt photo", () => {
    expect(m.receiptUrl).toBe(`/api/receipts/${view.drive.id}.r1/image`);
  });
});

describe("the two states of a drive", () => {
  it("a closed drive says the money went back", () => {
    const m = deriveLedger(fixture("closed"));
    expect(m.phase).toBe("closed");
    expect(m.restLabel).toBe("Returned to donors");
    expect(m.donors.map((d) => d.restWord)).toEqual(["back", "back", "back"]);
    expect(m.donors.map((d) => d.back)).toEqual([1542, 855, 1763]);
    expect(m.donors.every((d) => d.held === 0)).toBe(true);
    expect(m.book.filter((r) => r.need !== "Refused").every((r) => r.status === "Captured" && r.capture !== "—")).toBe(true);
  });

  it("an open drive says the money is held, and never that it returned", () => {
    const m = deriveLedger(fixture("open"));
    expect(m.phase).toBe("open");
    expect(m.restLabel).toBe("Held");
    expect(m.donors.map((d) => d.restWord)).toEqual(["held", "held", "held"]);
    expect(m.donors.map((d) => d.held)).toEqual([1542, 855, 1763]);
    expect(m.donors.every((d) => d.back === 0)).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/return/i);
    expect(m.book.filter((r) => r.need !== "Refused").every((r) => r.status === "Accrued" && r.capture === "—")).toBe(true);
  });

  it("a drive still closing is not called closed", () => {
    const view = fixture("closed");
    const m = deriveLedger({ ...view, drive: { ...view.drive, status: "closing" } });
    expect(m.restLabel).toBe("Held");
  });
});

describe("donors the map cannot place", () => {
  const view = fixture("closed");
  const withDonor = (donorName: string, donorCountry: string | null) =>
    deriveLedger({ ...view, holds: view.holds.map((h, i) => (i === 0 ? { ...h, donorName, donorCountry } : h)) });

  it("a town the table does not know lands in its country", () => {
    const d = withDonor("Ana (Évora)", "PT").donors[0];
    expect(d.label).toBe("Ana · Évora");
    expect(d.at).toEqual(locate(null, "PT"));
  });

  it("a city of that name in another country is not taken for it", () => {
    expect(withDonor("Ray (Paris)", "US").donors[0].at).toEqual(locate(null, "US"));
  });

  it("no place at all keeps the donor in the list, with no coordinates", () => {
    const m = withDonor("Sam", null);
    expect(m.donors[0]).toMatchObject({ label: "Sam", at: null, spentText: "€4.58", restText: "€15.42" });
    expect(m.promised).toBe(10783);
  });

  it("an unknown country code does not fall over", () => {
    expect(withDonor("Zed (Nowhere)", "XX").donors[0].at).toBeNull();
  });
});

describe("drives with less to show", () => {
  const view = fixture("open");

  it("no match, no receipt, no shares", () => {
    const m = deriveLedger({
      ...view,
      ledger: [],
      receipts: [],
      needs: view.needs.map((n) => ({ ...n, qtyCovered: 0, donorBase: 0 })),
      match: { ...view.match, usedBase: 0, holds: [] },
    });
    expect(m.spent).toBe(0);
    expect(m.rest).toBe(m.promised);
    expect(m.matchName).toBeNull();
    expect(m.receiptUrl).toBeNull();
    expect(m.refused).toEqual([]);
    expect(m.book).toEqual([]);
    expect(m.needs[0].percent).toBe(0);
  });

  it("a pledge nobody approved is not a promise", () => {
    const m = deriveLedger({ ...view, holds: view.holds.map((h, i) => (i === 0 ? { ...h, authorized: 0 } : h)) });
    expect(m.donors.map((d) => d.name)).toEqual(["Mark", "Yuki"]);
    expect(m.promised).toBe(10783 - 3247);
  });
});

describe("the map's projection and the card's name", () => {
  it("puts west left of east and north above south", () => {
    const [columbus, berlin, osaka] = [locate("Columbus", "US"), locate("Berlin", "DE"), locate("Osaka", "JP")].map((p) => project(p!.lon, p!.lat));
    expect(columbus.x).toBeLessThan(berlin.x);
    expect(berlin.x).toBeLessThan(osaka.x);
    expect(berlin.y).toBeLessThan(columbus.y);
    expect(columbus.y).toBeLessThan(osaka.y);
  });

  it("leaves a title with no such word alone", () => {
    expect(shelterName("Harbor Relief Kitchen")).toBe("Harbor Relief Kitchen");
  });
});
