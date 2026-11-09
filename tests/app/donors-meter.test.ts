import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Lang } from "@/ui/format";
import { deriveLedger } from "@/ui/ledger/derive";
import { LedgerStore } from "@/ui/ledger/store";
import { DonorsWidget } from "@/ui/ledger/widgets/DonorsWidget";
import { HOLD_WORDS } from "@/ui/ledger/words-hold";
import type { DriveView, Hold } from "@/ui/types";

// The phone's donors card (T1): each donor's hold as one bar (HoldMeter, the parts of hold-meter.ts), with the pledge
// above it and what was spent and the rest below. The showcase drive (closed) and the open fixture.

const showcase = () => (JSON.parse(readFileSync(path.join(__dirname, "../../evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;
const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;

function render(v: DriveView, lang: Lang) {
  const store = new LedgerStore(deriveLedger(v, lang), v);
  const params = { context: { store }, widgetApi: { setDisplayState: () => {} } } as never;
  return renderToStaticMarkup(createElement(DonorsWidget, params));
}
const rows = (html: string) => html.split("<li>").slice(1);
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/[  ]/g, " ");
const parts = (row: string) => [...row.matchAll(/data-part="(\w+)"/g)].map((x) => x[1]);

describe("the donors card on a phone draws each hold's bar", () => {
  it("closed showcase, EN: pledged, the bar of what was charged and what PayPal released, the rest in the never-charged colour", () => {
    const r = rows(render(showcase(), "en"));
    expect(r).toHaveLength(3);
    const lena = r[0];
    expect(lena).toContain('class="pas-meter pas-meter-card nm-donor-meter"');
    expect(parts(lena)).toEqual(["charged", "never"]);
    expect(text(lena)).toContain("€20.00 pledged");
    expect(text(lena)).toContain("€4.58 spent");
    expect(lena).toMatch(/class="lg-rest lg-rest-back nm-never-text"><b>€15\.42<\/b> never charged/);
    expect(text(r[1])).toContain("$30.00 pledged");
    expect(text(r[2])).toContain("¥3,000 pledged");
  });

  it("DE and JA: the same bars, the words in the reader's language", () => {
    const de = rows(render(showcase(), "de"));
    expect(parts(de[0])).toEqual(["charged", "never"]);
    expect(text(de[0])).toContain("20,00 € zugesagt");
    expect(text(de[0])).toContain("15,42 € nie belastet");
    const ja = rows(render(showcase(), "ja"));
    expect(parts(ja[2])).toEqual(["charged", "never"]);
    expect(text(ja[2])).toContain("¥3,000 を約束");
    expect(text(ja[2])).toContain("¥1,763 請求されず");
    for (const lang of ["en", "de", "ja"] as Lang[]) expect(HOLD_WORDS[lang].pledgedSum("X")).toContain("X");
  });

  it("an open drive: waiting and held, and nothing is called never charged", () => {
    const r = rows(render(fixture("open"), "en"));
    expect(parts(r[0])).toEqual(["waiting", "held"]);
    expect(r[0]).not.toContain("nm-never-text");
    expect(text(r[0])).toContain("€15.42 held");
  });

  it("the match has no row: its hold is the company's, not a donor's", () => {
    expect(render(showcase(), "en")).not.toContain("Kitasora Logistics");
  });

  it("the row's make-up does not depend on the amounts, and its height is fixed in the stylesheet and the slot", () => {
    const skeleton = (html: string) => html.replace(/>[^<]*</g, "><").replace(/ (style|aria-label|data-donor-row|aria-pressed)="[^"]*"/g, "");
    const big = showcase();
    for (const h of big.holds as Hold[]) Object.assign(h, { authorized: h.authorized * 1000, captured: h.captured * 1000, released: h.released * 1000 });
    for (const r of big.ledger) if (r.amount !== null) Object.assign(r, { amount: r.amount * 1000, base: r.base * 1000 });
    expect(skeleton(render(big, "de"))).toBe(skeleton(render(showcase(), "de")));
    const css = readFileSync(path.join(__dirname, "../../src/ui/ledger/need-meter.css"), "utf8");
    expect(css).toMatch(/\.lg-donors \.nm-donor \{ height: 92px;/);
    expect(readFileSync(path.join(__dirname, "../../src/ui/ledger/LedgerStudio.tsx"), "utf8")).toContain("donors: Math.ceil((62 + counts.donors * 94) / rowHeight)");
  });
});
