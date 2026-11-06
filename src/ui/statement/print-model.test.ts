import { describe, expect, it } from "vitest";
import { lenaStatement } from "../../../tests/fixtures/statement/lena";
import { printModel } from "./print-model";

const m = printModel(lenaStatement);

describe("printModel", () => {
  it("names the donor, the drive and the hold", () => {
    expect(m.driveTitle).toBe("Kitasora flood relief (demo)");
    expect(m.donor).toBe("Lena (Berlin) & \"Partners\" <GmbH>");
    expect(m.pledgeId).toBe("demo-f372326129.water");
    expect(m.holdId).toBe("2Y816602392541815");
    expect(m.holdExpires).toBe("30 Nov 2026");
  });

  it("shows receipt lines relative to the drive and money in both currencies", () => {
    expect(m.rows[0]).toMatchObject({ line: "r1 · 1", item: "Drinking water 2 L", qty: "6 × bottle 2 L", share: "€2.46", match: "¥399", captureId: "3WP65983GD053501C" });
    expect(m.rows[3]).toMatchObject({ line: "r2 · 1", status: "Not collected", note: "hold_expired", captureId: null });
    expect(m.rows[2]).toMatchObject({ status: "Captured, partly taken back", note: "€0.30 taken back by PayPal" });
  });

  it("totals are the statement's own numbers, formatted", () => {
    const t = Object.fromEntries(m.totals.map((x) => [x.label, x.value]));
    expect(t["Pledged"]).toBe("€20.00");
    expect(t["Charged"]).toBe("€4.28");
    expect(t["Taken back by PayPal after capture"]).toBe("€0.30");
    expect(t["Not collected"]).toBe("€1.20");
    expect(t["Help bought, total"]).toBe("¥2,136");
  });

  it("leaves out zero-valued optional totals", () => {
    const quiet = structuredClone(lenaStatement);
    quiet.statement.totals.reversed = 0;
    quiet.statement.totals.uncollected = 0;
    const labels = printModel(quiet).totals.map((x) => x.label);
    expect(labels).not.toContain("Taken back by PayPal after capture");
    expect(labels).not.toContain("Not collected");
    expect(labels).toContain("Charged");
  });

  it("says so when the pledge bought nothing", () => {
    const empty = structuredClone(lenaStatement);
    empty.statement.rows = [];
    expect(printModel(empty).rows).toEqual([]);
  });
});
