import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { statementLines } from "@/ui/statement/lines";
import { LineProofs } from "@/ui/statement/LineProofs";
import type { DriveView, Statement } from "@/ui/types";

// "My euro in the receipt" (P1): on the donor's statement, each receipt line the donor paid for, with the donor's share,
// the line's place on the published photo for its strip, and its words. The showcase drive, demo-810b24be50.

const showcase = () => (JSON.parse(readFileSync(path.join(__dirname, "../../evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;

/** The statement rows the service builds for one donor, from the view's ledger (only the fields the lines read). */
function statementOf(v: DriveView, name: string): Statement {
  const shares = v.ledger.filter((r) => r.kind === "donor_share" && r.donorName?.startsWith(name));
  return {
    currency: shares[0].currency,
    rows: shares.map((r) => ({ receiptId: r.receiptId, lineNo: r.lineNo, share: { minor: r.amount, currency: r.currency } })),
  } as unknown as Statement;
}

describe("statementLines on the showcase drive", () => {
  const v = showcase();
  const receipt = v.receipts[0].id;

  it("Lena: lines 1-3 of the receipt, her share of each in euros, the printed words, the English, a strip on the published photo", () => {
    const lines = statementLines(v, statementOf(v, "Lena"), receipt, [3, 1, 2, 1]);
    expect(lines.map((l) => [l.lineNo, l.share, l.currency])).toEqual([
      [1, 246, "EUR"],
      [2, 145, "EUR"],
      [3, 67, "EUR"],
    ]);
    expect(lines[0].printed).toBe("北空の天然水 2L 6本ケース");
    expect(lines[0].english).toBe("Natural water 2L case");
    expect(lines[0].photo?.url).toBe(`/api/receipts/${receipt}/image`);
    expect(lines[0].photo?.box).toEqual(v.receipts[0].lines[0].box);
  });

  it("Mark in dollars and Yuki in yen: the shares add up to what each paid", () => {
    const mark = statementLines(v, statementOf(v, "Mark"), receipt, [4, 5, 6]);
    expect(mark.reduce((s, l) => s + l.share, 0)).toBe(858 + 1089 + 198);
    expect(mark[0].currency).toBe("USD");
    const yuki = statementLines(v, statementOf(v, "Yuki"), receipt, [7, 8, 9]);
    expect(yuki.map((l) => l.share)).toEqual([349, 398, 490]);
    expect(yuki[0].currency).toBe("JPY");
  });

  it("a line the reader did not place: no strip, said so; an unpublished photo: no strip at all", () => {
    const unplaced = showcase();
    unplaced.receipts[0].lines[0].box = null;
    const [first] = statementLines(unplaced, statementOf(unplaced, "Lena"), receipt, [1]);
    expect(first.photo).toBeNull();
    const html = renderToStaticMarkup(createElement(LineProofs, { lines: [first] }));
    expect(html).toContain("not placed on the photo");
    expect(html).toContain("北空の天然水 2L 6本ケース");
    expect(html).not.toContain("lg-strip");
    const hidden = showcase();
    hidden.receipts[0].image = { published: false, note: "closed" } as DriveView["receipts"][number]["image"];
    expect(statementLines(hidden, statementOf(hidden, "Lena"), receipt, [1, 2, 3]).every((l) => l.photo === null)).toBe(true);
  });

  it("the card: one entry per line with the share and the English; a translation, when given, takes the English's place in its language", () => {
    const lines = statementLines(v, statementOf(v, "Lena"), receipt, [1, 2, 3]);
    const html = renderToStaticMarkup(createElement(LineProofs, { lines }));
    expect(html.match(/data-line="/g)).toHaveLength(3);
    expect(html).toContain("€2.46");
    expect(html).toContain('lang="en">Natural water 2L case');
    const de = renderToStaticMarkup(createElement(LineProofs, { lines, translations: new Map([[1, { lang: "de", text: "Natürliches Wasser 2 l, Kiste" }]]) }));
    expect(de).toContain('lang="de">Natürliches Wasser 2 l, Kiste');
    expect(de).toContain('lang="en">Melted snow water 2L');
  });
});
