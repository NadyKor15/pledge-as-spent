import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerStarter } from "@/agent/starters";
import { ledgerRefusals } from "@/agent/tools";
import { bookRefusals, lineViews, refusalSummary, refusedCount, refusedTotal } from "@/ui/derive";
import { deriveLedger } from "@/ui/ledger/derive";
import { LANGS, WORDS } from "@/ui/ledger/i18n";
import type { DriveView, ReceiptLine } from "@/ui/types";

// The Ledger's "Refused:" line lists what the Coordinator's refused total adds up: each refused line, then the
// discounts counted with it (a discount has no row of its own in the book). Receipts without discounts are unchanged.

const ROOT = path.join(__dirname, "../..");
const read = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const closed = () => read("tests/fixtures/drives/closed.json") as DriveView;
const open = () => read("tests/fixtures/drives/open.json") as DriveView;
const showcase = () => (read("evidence/control-drive-20261109-810b24be50.json") as { drive: DriveView }).drive;

/** "¥1,198" -> 1198, "−¥43" -> -43 (English yen, as the list prints it). */
const yen = (s: string) => (s.startsWith("−") ? -1 : 1) * Number(s.replace(/[^0-9]/g, ""));
const shown = (v: DriveView, lang: "en" | "de" | "ja" = "en") => deriveLedger(v, lang).refused.map((r) => `${r.name} ${r.amount}`);

describe("a receipt without discounts: the list is what it was", () => {
  // Taken from the Ledger before discounts were listed (same keys, names and amounts, in every language).
  const before = (id: string) => ({
    en: [
      { key: `${id}:10`, name: "Alcohol", amount: "¥1,198" },
      { key: `${id}:11`, name: "Gift card", amount: "¥3,000" },
    ],
    de: [
      { key: `${id}:10`, name: "Alkohol", amount: "1.198 ¥" },
      { key: `${id}:11`, name: "Gutschein", amount: "3.000 ¥" },
    ],
    ja: [
      { key: `${id}:10`, name: "酒類", amount: "¥1,198" },
      { key: `${id}:11`, name: "ギフトカード", amount: "¥3,000" },
    ],
  });

  it.each([
    ["closed", closed, "demo-f372326129.r1"],
    ["open", open, "demo-4e8aa74db5.r1"],
    ["showcase", showcase, "demo-810b24be50.r1"],
  ] as const)("the %s drive", (_, load, receiptId) => {
    const v = load();
    for (const lang of LANGS) expect(deriveLedger(v, lang).refused).toEqual(before(receiptId)[lang]);
  });
});

describe("discounts under refused lines, and one under a funded line", () => {
  /** The sample receipt with two coupons under the refused beer (line 10) and one under the funded water (line 1). */
  function withCoupons(): DriveView {
    const v = closed();
    const r = v.receipts[0];
    const coupon = (lineNo: number, amount: number): ReceiptLine => ({ ...r.lines[0], lineNo, text: "値引", translationEn: "Discount", amount, needId: null, needQty: null, box: null });
    const at = (n: number) => r.lines.findIndex((l) => l.lineNo === n) + 1;
    r.lines.splice(at(10), 0, coupon(12, -100), coupon(13, -50));
    r.lines.splice(at(1), 0, coupon(14, -30));
    return v;
  }

  it("each coupon of a refused line follows it; the funded line's coupon is not refused", () => {
    expect(shown(withCoupons())).toEqual(["Alcohol ¥1,198", "discount −¥100", "discount −¥50", "Gift card ¥3,000"]);
    expect(shown(withCoupons(), "de")).toEqual(["Alkohol 1.198 ¥", "Rabatt −100 ¥", "Rabatt −50 ¥", "Gutschein 3.000 ¥"]);
    expect(shown(withCoupons(), "ja")).toEqual(["酒類 ¥1,198", "値引き −¥100", "値引き −¥50", "ギフトカード ¥3,000"]);
    expect(deriveLedger(withCoupons()).refused.map((r) => r.key)).toEqual(["demo-f372326129.r1:10", "demo-f372326129.r1:12", "demo-f372326129.r1:13", "demo-f372326129.r1:11"]);
  });

  it("a funded line with a part refused (its need was covered) is a funded line, its coupon on the funded side", () => {
    const v = withCoupons();
    const beer = v.ledger.find((r) => r.lineNo === 10 && r.kind === "rejected")!;
    v.ledger.push({ ...beer, rowId: `${beer.receiptId}:1/need_covered`, lineNo: 1, needId: "water", base: 100, code: "need_covered" });
    expect(lineViews(v, v.receipts[0]).find((l) => l.line.lineNo === 14)!.state).toBe("approved");
    // As on the Coordinator: neither the line nor its coupon is a refusal (the covered part stays in the book).
    expect(shown(v)).toEqual(["Alcohol ¥1,198", "discount −¥100", "discount −¥50", "Gift card ¥3,000"]);
  });

  it("a line no hold could pay (unfunded) is listed like a refused one, as the Coordinator counts it", () => {
    const v = withCoupons();
    const card = v.ledger.find((r) => r.lineNo === 11 && r.kind === "rejected")!;
    Object.assign(card, { kind: "unfunded", status: "unfunded", code: null });
    expect(shown(v)).toEqual(["Alcohol ¥1,198", "discount −¥100", "discount −¥50", "Gift card ¥3,000"]);
    expect(bookRefusals(v).total).toBe(refusedTotal(lineViews(v, v.receipts[0])));
  });

  it("the list adds up to the Coordinator's refused total, and the coupons are not counted as lines", () => {
    const v = withCoupons();
    const lines = lineViews(v, v.receipts[0]);
    const listed = deriveLedger(v).refused.reduce((s, r) => s + yen(r.amount), 0);
    expect(listed).toBe(1198 - 100 - 50 + 3000);
    expect(refusedTotal(lines)).toBe(listed);
    expect(refusedCount(lines)).toBe(2);
    // The one summary behind both, per receipt and for the book.
    expect([refusalSummary(v, v.receipts[0]).count, refusalSummary(v, v.receipts[0]).total]).toEqual([2, listed]);
    expect([bookRefusals(v).count, bookRefusals(v).total]).toEqual([2, listed]);
    // Each coupon is counted with the line above it, refused or funded.
    expect(lines.filter((l) => l.countedWith !== undefined).map((l) => [l.line.lineNo, l.countedWith, l.state])).toEqual([
      [14, 1, "approved"],
      [12, 10, "rejected"],
      [13, 10, "rejected"],
    ]);
  });
});

describe("the assistant on receipts without discounts: the same answers as before, byte for byte", () => {
  /** ledger_refusals as it answered before discounts were counted; the printed text and the reasons are the fixture's. */
  function before(v: DriveView) {
    const r = v.receipts[0];
    const line = (n: number) => r.lines.find((l) => l.lineNo === n)!;
    const why = (n: number) => v.ledger.find((x) => x.lineNo === n && x.kind === "rejected")!.reasonEn;
    const key = (n: number) => `${r.id}:${n}`;
    return {
      text:
        "2 lines refused, ¥4,198 in total; no donor money was used for them:\n" +
        `- line 10 "${line(10).text}" (English: ${line(10).translationEn}): ¥1,198 refused (rule: alcohol) — ${why(10)}\n` +
        `- line 11 "${line(11).text}" (English: ${line(11).translationEn}): ¥3,000 refused (rule: gift card) — ${why(11)}`,
      data: {
        facts: [
          { value: 1198, currency: "JPY", label: "line 10 refused", lineKey: key(10) },
          { value: 3000, currency: "JPY", label: "line 11 refused", lineKey: key(11) },
          { value: 4198, currency: "JPY", label: "refused in total", lineKeys: [key(10), key(11)] },
        ],
        lineKeys: [key(10), key(11)],
      },
    };
  }
  // The quick question "Why was a line refused?", as it answered before (the German amounts keep their no-break space).
  const STARTER = {
    en: "2 lines were refused, ¥4,198 in total, and no donor paid for them: line 10, alcohol for ¥1,198: alcohol is never funded; line 11, a gift card for ¥3,000: gift cards are never funded.",
    de: "2 Zeilen wurden abgelehnt, insgesamt 4.198 ¥; kein Spender hat dafür bezahlt: Zeile 10, Alkohol für 1.198 ¥: Alkohol wird nie finanziert; Zeile 11, Geschenkkarte für 3.000 ¥: Geschenkkarten werden nie finanziert.",
    ja: "却下された行は2行、合計￥4,198で、寄付者の支払いはありません：10行目のアルコール（￥1,198）：アルコールは対象外です。11行目のギフトカード（￥3,000）：ギフトカードは対象外です。",
  };

  it.each([
    ["closed", closed],
    ["open", open],
    ["showcase", showcase],
  ] as const)("the %s drive", (_, load) => {
    const v = load();
    expect(ledgerRefusals(v)).toEqual(before(v));
    for (const lang of LANGS) {
      const a = answerStarter(v, "refused", null, lang);
      expect(a.text).toBe(STARTER[lang]);
      expect([a.facts, a.lineKeys, a.verdict.ok]).toEqual([before(v).data.facts, before(v).data.lineKeys, true]);
    }
  });
});

describe("the word for a discount", () => {
  it("exists in each language", () => {
    expect(LANGS.map((lang) => WORDS[lang].discount)).toEqual(["discount", "Rabatt", "値引き"]);
  });
});
