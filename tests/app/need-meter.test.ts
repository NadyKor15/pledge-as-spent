import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Lang } from "@/ui/format";
import { deriveLedger } from "@/ui/ledger/derive";
import { meterLine, meterWidths, needMeter, tonesOf } from "@/ui/ledger/need-meter";
import { LedgerStore } from "@/ui/ledger/store";
import { ShelterWidget } from "@/ui/ledger/widgets/ShelterWidget";
import { HOLD_WORDS } from "@/ui/ledger/words-hold";
import type { DriveView, Hold, LedgerRow } from "@/ui/types";

// The shelter card's bars (T2): each need's money in tones on its own total, from the drive view only. The showcase
// drive (demo-810b24be50, closed) and an open drive caught with all three tones at once.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;
const showcase = () => (JSON.parse(readFileSync(path.join(__dirname, "../../evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;
const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name)) as Hold;
const sharesOf = (v: DriveView, needId: string) => v.ledger.filter((r) => (r.kind === "donor_share" || r.kind === "match_share") && r.needId === needId);

/** The open drive after PayPal took the first water line: bought, waiting and promised on one bar. */
function openThreeTones(): DriveView {
  const v = fixture("open");
  const first = sharesOf(v, "water").filter((r) => r.lineNo === Math.min(...sharesOf(v, "water").map((x) => x.lineNo)));
  for (const r of first) {
    r.status = "captured";
    const h = v.holds.find((x) => x.pledgeId === r.pledgeId) as Hold;
    h.accrued -= r.amount ?? 0;
    h.captured += r.amount ?? 0;
  }
  return v;
}

/** PayPal took a share and gave it back: that donor's rest was charged first, so it is not "never charged". */
function refund(v: DriveView, row: LedgerRow) {
  row.reversed = row.amount;
  row.status = "reversed";
  const h = holdOf(v, row.donorName ?? "");
  h.captured -= row.amount ?? 0;
  h.reversed += row.amount ?? 0;
}

describe("needMeter on the showcase drive (closed, every hold voided by PayPal)", () => {
  const v = showcase();
  const m = deriveLedger(v, "en");
  const meter = (id: string) => needMeter(v, id, m);

  it("water: Lena's €4.58 and the match bought, €15.42 of her hold never charged", () => {
    const w = meter("water");
    const lena = sharesOf(v, "water").reduce((s, r) => s + r.base, 0);
    expect(w.bought).toBe(lena);
    expect(w.waiting).toBe(0);
    expect(w.promised).toBe(0);
    expect(w.neverIn).toEqual([{ currency: "EUR", minor: 1542 }]);
    expect(w.never).toBe(m.donors.find((d) => d.name === "Lena")!.backBase);
    expect(w.total).toBe(w.bought + w.never);
    expect(meterLine(w, "en")).toBe("€15.42 never charged");
  });

  it("diapers: Mark's $21.45 bought (with the match), $8.55 never charged; batteries: Yuki ¥1,237, ¥1,763 never charged", () => {
    expect(meterLine(meter("diapers"), "en")).toBe("$8.55 never charged");
    expect(meterLine(meter("batteries"), "en")).toBe("¥1,763 never charged");
    const aa = meter("batteries");
    expect(aa.bought).toBe(2 * 1237);
    expect(aa.never).toBe(1763);
    expect(meterWidths(aa).bought + meterWidths(aa).never).toBeCloseTo(100, 6);
  });

  it("the match has no need: it is in bought through its shares, and its own released hold is in no need's never", () => {
    const all = v.needs.map((n) => meter(n.needId));
    const neverSum = all.reduce((s, x) => s + x.never, 0);
    expect(neverSum).toBe(m.returned);
    expect(all.reduce((s, x) => s + x.bought, 0)).toBe(m.spent + m.match);
  });

  it("the legend shows only bought and never charged", () => {
    expect(tonesOf(v.needs.map((n) => meter(n.needId)))).toEqual(["bought", "never"]);
  });

  it("does not read the core's donorCapacityBase (0 on the showcase)", () => {
    expect(v.needs.every((n) => n.donorCapacityBase === 0)).toBe(true);
    expect(meter("water").never).toBeGreaterThan(0);
  });
});

describe("needMeter on an open drive", () => {
  it("three tones: bought, approved and waiting for PayPal, promised on Lena's hold", () => {
    const v = openThreeTones();
    const w = needMeter(v, "water");
    expect(w.bought).toBeGreaterThan(0);
    expect(w.waiting).toBeGreaterThan(0);
    expect(w.promised).toBe(deriveLedger(v).donors.find((d) => d.name === "Lena")!.heldBase);
    expect(w.never).toBe(0);
    expect(w.total).toBe(w.bought + w.waiting + w.promised);
    expect(meterLine(w, "en")).toBe("€15.42 promised on Lena’s hold, nobody charged");
    expect(tonesOf([w])).toEqual(["bought", "waiting", "promised"]);
    const pc = meterWidths(w);
    expect(pc.bought + pc.waiting + pc.promised).toBeCloseTo(100, 6);
  });

  it("the open fixture as it is: nothing captured yet, so no bought tone", () => {
    const v = fixture("open");
    expect(tonesOf(v.needs.map((n) => needMeter(v, n.needId)))).toEqual(["waiting", "promised"]);
  });

  it("two donors on one need in two currencies: the amounts by currency, the holds counted", () => {
    const v = fixture("open");
    holdOf(v, "Mark").needId = "water";
    const w = needMeter(v, "water");
    expect(w.promisedBy).toEqual(["Lena", "Mark"]);
    expect(meterLine(w, "en")).toBe("€15.42 · $8.55 promised on 2 holds, nobody charged");
    expect(meterLine(w, "de")).toBe("15,42 € · 8,55 $ zugesagt in 2 Reservierungen, niemand belastet");
    expect(meterLine(w, "ja")).toMatch(/は2件の保留に約束済み・誰も請求されず$/);
  });

  it("a withdrawn hold PayPal has not voided yet is on its way back, not promised and not never charged", () => {
    const v = fixture("open");
    holdOf(v, "Lena").revoked = true;
    const w = needMeter(v, "water");
    expect(w.promised).toBe(0);
    expect(w.never).toBe(0);
    expect(meterLine(w, "en")).toBe("€15.42 on its way back at PayPal");
  });
});

describe("never charged only where PayPal released the hold", () => {
  it("must differ: after a refund, Mark's rest is returned, not never charged; Lena's stays never charged", () => {
    const v = showcase();
    refund(v, v.ledger.find((r) => r.kind === "donor_share" && r.donorName?.startsWith("Mark")) as LedgerRow);
    const d = needMeter(v, "diapers");
    expect(d.never).toBe(0);
    expect(d.neverIn).toEqual([]);
    expect(meterLine(d, "en")).toMatch(/ returned$/);
    expect(meterLine(needMeter(v, "water"), "en")).toBe("€15.42 never charged");
  });

  it("a closed drive whose void is still on its way: on its way back, not never charged", () => {
    const v = showcase();
    Object.assign(holdOf(v, "Lena"), { status: "authorized", released: 0 });
    const w = needMeter(v, "water");
    expect(w.never).toBe(0);
    expect(meterLine(w, "en")).toBe("€15.42 on its way back at PayPal");
  });
});

describe("the words of the meters", () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, val]) => (val && typeof val === "object" ? keys(val).map((x) => `${k}.${x}`) : [k])).sort();

  it("every key in every language, none empty", () => {
    const en = keys(HOLD_WORDS.en);
    for (const lang of ["de", "ja"] as Lang[]) expect(keys(HOLD_WORDS[lang])).toEqual(en);
    for (const lang of ["en", "de", "ja"] as Lang[]) {
      const w = HOLD_WORDS[lang];
      for (const t of Object.values(w.tone)) expect(t.length).toBeGreaterThan(0);
      for (const f of [w.promisedOn("X", "N"), w.promisedOnMany("X", 2), w.neverChargedSum("X"), w.onItsWayBack("X"), w.returnedSum("X")]) expect(f).toContain("X");
    }
  });

  it("never charged is said as the rest of the Ledger says it", () => {
    expect(HOLD_WORDS.en.neverChargedSum("X")).toBe("X never charged");
    expect(HOLD_WORDS.de.neverChargedSum("X")).toBe("X nie belastet");
    expect(HOLD_WORDS.ja.neverChargedSum("X")).toBe("X 請求されず");
  });
});

describe("the shelter card draws the tones and the money lines", () => {
  const render = (v: DriveView, lang: Lang) => {
    const store = new LedgerStore(deriveLedger(v, lang), v);
    const params = { context: { store }, widgetApi: { setDisplayState: () => {} } } as never;
    return renderToStaticMarkup(createElement(ShelterWidget, params));
  };
  const tonesIn = (html: string) => [...html.matchAll(/class="nm-seg nm-(\w+)"/g)].map((x) => x[1]);

  it("closed showcase, EN / DE / JA: bought and never charged on each need, the line and a two-tone legend", () => {
    const v = showcase();
    const lines: Record<Lang, string[]> = {
      en: ["€15.42 never charged", "$8.55 never charged", "¥1,763 never charged"],
      de: ["15,42 € nie belastet", "8,55 $ nie belastet", "1.763 ¥ nie belastet"],
      ja: ["€15.42 請求されず", "$8.55 請求されず", "¥1,763 請求されず"],
    };
    for (const lang of ["en", "de", "ja"] as Lang[]) {
      const html = render(v, lang);
      expect(tonesIn(html)).toEqual(["bought", "never", "bought", "never", "bought", "never"]);
      const money = [...html.matchAll(/<span class="nm-money" data-label="[^"]*">([^<]*)<\/span>/g)].map((x) => x[1].replace(/&nbsp;/g, " "));
      expect(money.map((s) => s.replace(/[  ]/g, " "))).toEqual(lines[lang].map((s) => s.replace(/[  ]/g, " ")));
      expect([...html.matchAll(/role="listitem" data-tone="(\w+)"/g)].map((x) => x[1])).toEqual(["bought", "never"]);
      expect(html).toContain(HOLD_WORDS[lang].tone.never);
    }
  });

  it("open with three tones: the water bar has bought, waiting and promised, and the legend all three", () => {
    const html = render(openThreeTones(), "en");
    expect(tonesIn(html).slice(0, 3)).toEqual(["bought", "waiting", "promised"]);
    expect(html).toContain("€15.42 promised on Lena’s hold, nobody charged");
    expect([...html.matchAll(/role="listitem" data-tone="(\w+)"/g)].map((x) => x[1])).toEqual(["bought", "waiting", "promised"]);
  });
});
