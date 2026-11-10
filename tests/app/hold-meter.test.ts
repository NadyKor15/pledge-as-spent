import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HoldMeter } from "@/ui/HoldMeter";
import { meterLabel, meterParts, meterSegments, METER_KEYS } from "@/ui/hold-meter";
import type { DriveView, Hold } from "@/ui/types";

// One donor's hold as a bar: what PayPal took, what waits for it, what the hold still keeps, what is on its way back,
// what PayPal released and so never charged, and what was charged and then refunded. The parts add up to the hold.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name)) as Hold;
const sum = (p: ReturnType<typeof meterParts>) => METER_KEYS.reduce((s, k) => s + p[k], 0);

describe("the parts of a hold", () => {
  it("a closed drive: Lena's €20 is €4.58 spent and €15.42 never charged, nothing else", () => {
    const p = meterParts(holdOf(fixture("closed"), "Lena"));
    expect(p).toEqual({ currency: "EUR", total: 2000, charged: 458, waiting: 0, held: 0, returning: 0, never: 1542, back: 0 });
  });

  it("an open drive: what waits for the capture, and what the hold still keeps", () => {
    const h = holdOf(fixture("open"), "Lena");
    const p = meterParts(h);
    expect(p.waiting).toBe(h.accrued + h.capturePending);
    expect(p.held).toBeGreaterThan(0);
    expect([p.never, p.back, p.returning]).toEqual([0, 0, 0]);
    expect(sum(p)).toBe(p.total);
  });

  it("must differ: a share charged and then refunded is 'back', never 'never charged'", () => {
    const h = { ...holdOf(fixture("closed"), "Mark") };
    h.captured -= 500;
    h.reversed += 500;
    const p = meterParts(h);
    expect(p.back).toBe(500);
    expect(p.never).toBe(855);
    expect(sum(p)).toBe(p.total);
  });

  it("a withdrawn hold before PayPal's void: on its way back, not yet never charged", () => {
    const h = { ...holdOf(fixture("open"), "Yuki"), revoked: true };
    const p = meterParts(h);
    expect(p.returning).toBeGreaterThan(0);
    expect([p.held, p.never]).toEqual([0, 0]);
    expect(sum(p)).toBe(p.total);
  });

  it("an uncollected share: still on a live hold until the void, never charged once the hold is over", () => {
    const live = { ...holdOf(fixture("open"), "Lena"), accrued: 0, capturePending: 0, uncollected: 300 };
    expect(meterParts(live).held).toBe(meterParts({ ...live, uncollected: 0 }).held);
    expect(meterParts(live).never).toBe(0);
    const over = { ...holdOf(fixture("closed"), "Lena"), released: 1242, uncollected: 300 };
    expect(meterParts(over).never).toBe(1542);
  });

  it("whatever the book holds, the parts are never negative and add up to the hold", () => {
    const statuses = ["authorized", "partially_captured", "captured", "voided", "expired"] as const;
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.constantFrom(...statuses), fc.boolean(), (captured, pending, accrued, released, uncollected, reversed, status, revoked) => {
        const authorized = captured + pending + accrued + released + uncollected + reversed + 1000;
        const h = { ...holdOf(fixture("open"), "Lena"), authorized, captured, capturePending: pending, accrued, released, uncollected, reversed, status, revoked };
        const p = meterParts(h);
        for (const k of METER_KEYS) expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(sum(p)).toBe(authorized);
      }),
    );
  });
});

describe("the bar", () => {
  const lena = meterParts(holdOf(fixture("closed"), "Lena"));

  it("only the parts there are, in their order, each its share of the hold", () => {
    expect(meterSegments(lena)).toEqual([
      { key: "charged", value: 458, pct: 22.9 },
      { key: "never", value: 1542, pct: 77.1 },
    ]);
  });

  it("says itself in words, in three languages", () => {
    expect(meterLabel(lena, "en")).toBe("€4.58 spent, €15.42 never charged");
    expect(meterLabel(lena, "de")).toBe("4,58 € ausgegeben, 15,42 € nie belastet");
    expect(meterLabel(lena, "ja")).toBe("€4.58 支出、€15.42 請求されず");
  });

  it("renders as one image with a part per segment, in each size", () => {
    for (const size of ["card", "label", "cell"] as const) {
      const html = renderToStaticMarkup(createElement(HoldMeter, { parts: lena, size, lang: "en" }));
      expect(html).toContain('role="img"');
      expect(html).toContain('aria-label="€4.58 spent, €15.42 never charged"');
      expect(html).toContain(`pas-meter-${size}`);
      expect(html.match(/data-part="/g)).toHaveLength(2);
      expect(html).toContain('data-part="never" style="width:77.1%"');
    }
  });

  it("an empty hold draws an empty track and says nothing it does not know", () => {
    const empty = { ...lena, total: 0, charged: 0, never: 0 };
    expect(meterSegments(empty)).toEqual([]);
    expect(renderToStaticMarkup(createElement(HoldMeter, { parts: empty, size: "card", lang: "en" }))).not.toContain("data-part");
  });
});

describe("the bar's colours, as on sheet A (NM11 17:37:28Z)", () => {
  it("never charged is the light grey-blue of the statement's bar; its figures the graphite", () => {
    const css = readFileSync(path.join(__dirname, "../../src/ui/hold-meter.css"), "utf8");
    expect(css).toContain("--pas-never: #B8C0CA;");
    expect(css).toContain("--pas-never-text: #586478;");
    expect(css).toContain("--pas-charged: #2F855A;");
  });
});

