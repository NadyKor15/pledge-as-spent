import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bookCsv, deriveLedger } from "@/ui/ledger/derive";
import { LANGS, needLabel, parseLang, WORDS } from "@/ui/ledger/i18n";
import type { DriveView } from "@/ui/types";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8")) as DriveView;

describe("the Ledger in three languages: the same figures, other words", () => {
  const closed = fixture("closed");
  const open = fixture("open");

  it("English is the default and the model the tests above know", () => {
    expect(deriveLedger(closed, "en")).toEqual(deriveLedger(closed));
    expect(parseLang("ja")).toBe("ja");
    expect(parseLang("fr")).toBe("en");
    expect(parseLang(null)).toBe("en");
  });

  it("every language adds up the same: only the words and the way amounts are written change", () => {
    const pick = (lang: "en" | "de" | "ja") => {
      const m = deriveLedger(closed, lang);
      return { n: [m.promised, m.spent, m.returned, m.match], book: m.book.map((r) => [r.rowKey, r.share, r.capture, r.code]), donors: m.donors.map((d) => [d.spent, d.back, d.spentBase]) };
    };
    expect(pick("de")).toEqual(pick("en"));
    expect(pick("ja")).toEqual(pick("en"));
  });

  it("German", () => {
    const m = deriveLedger(closed, "de");
    expect(m.lang).toBe("de");
    expect([m.spentLabel, m.restLabel]).toEqual(["Für Bedarf ausgegeben", "An Spender zurück"]);
    expect(m.shelterTotal).toBe("10.448 ¥ mit Zuschuss");
    expect(m.receiptTotal).toBe("Beleg 14.646 ¥");
    expect(m.rates).toBe("Kurse bei Zusage: 1 € = 162,35 ¥ · 1 $ = 151,20 ¥");
    expect(m.needs.map((n) => [n.label, n.count])).toEqual([
      ["Wasser 2 L", "12 von 40 Flaschen"],
      ["Windeln Größe M", "6 von 6 Packungen"],
      ["AA-Batterien", "50 von 50"],
    ]);
    const mark = m.donors.find((d) => d.name === "Mark")!;
    expect([mark.spentText, mark.restText, mark.words?.spent, mark.words?.rest]).toEqual(["21,45 $", "8,55 $", "ausgegeben", "zurück"]);
    expect(m.refused.map((r) => `${r.name} ${r.amount}`)).toEqual(["Alkohol 1.198 ¥", "Gutschein 3.000 ¥"]);
    expect(new Set(m.book.map((r) => r.status))).toEqual(new Set(["Bezahlt", "Abgelehnt"]));
  });

  it("Japanese: the receipt's own printed name, yen as the receipt prints it", () => {
    const m = deriveLedger(closed, "ja");
    expect([m.spentLabel, m.restLabel, m.shelterTotal]).toEqual(["必要品に支出", "寄付者へ返金", "マッチング込み ¥10,448"]);
    const line4 = m.book.find((r) => r.line === 4 && r.kind === "donor_share")!;
    expect(line4.item).toBe("ソフトキッズおおむつ M 44 枚");
    expect([line4.needShown, line4.paid, line4.status]).toEqual(["おむつ Mサイズ", "$8.58", "支出済み"]);
    expect(m.needs.map((n) => n.count)).toEqual(["12 / 40本", "6 / 6パック", "50 / 50個"]);
  });

  it("an open drive's notes and words, in German", () => {
    const m = deriveLedger(open, "de");
    expect(m.spentLabel).toBe("Für Bedarf freigegeben");
    expect(m.restLabel).toBe("Reserviert");
    expect(m.waitingNote).toMatch(/^5\.224 ¥ warten auf die (tägliche|nächste) Abbuchung$/);
    expect(new Set(m.book.map((r) => r.status))).toEqual(new Set(["Wartet auf Abbuchung", "Abgelehnt"]));
  });

  it("a need label that is not the demo's stays as the drive wrote it", () => {
    expect(needLabel("de", "water", "Water 2 L")).toBe("Wasser 2 L");
    expect(needLabel("de", "water", "Bottled water")).toBe("Bottled water");
    expect(needLabel("ja", "blankets", "Blankets")).toBe("Blankets");
  });

  it("the book's CSV heads its columns in the language of the screen", () => {
    expect(bookCsv(deriveLedger(closed, "de")).split("\r\n")[0]).toBe("Beleg,Zeile,Belegzeile,Bedarf,Zahler,Anteil (JPY),Ausgegeben,PayPal-Abbuchung,Status");
    expect(bookCsv(deriveLedger(closed)).split("\r\n")[0]).toBe("Receipt,Line,Item,Need,Payer,Share (JPY),Spent,PayPal capture,Status");
  });

  it("every language has every word", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]));
    const en = keys(WORDS.en).sort();
    for (const lang of LANGS) expect(keys(WORDS[lang]).filter((k) => !k.startsWith("phoneStatus.")).sort()).toEqual(en.filter((k) => !k.startsWith("phoneStatus.")));
  });
});

describe("what the book shows of each row", () => {
  const m = deriveLedger(fixture("closed"));
  const row = (line: number, kind: string) => m.book.find((r) => r.line === line && r.kind === kind)!;

  it("the payer with their town, the share in the payer's own money, the match named as one", () => {
    expect([row(4, "donor_share").payerLabel, row(4, "donor_share").paid]).toEqual(["Mark · Columbus", "$8.58"]);
    expect([row(4, "match_share").payerLabel, row(4, "match_share").paid]).toEqual(["Kitasora Logistics (match)", "¥1,298"]);
    expect([row(1, "donor_share").payerLabel, row(1, "donor_share").paid]).toEqual(["Lena · Berlin", "€2.46"]);
  });

  it("each row keeps its own key, its status code and, when refused, the reason", () => {
    expect(new Set(m.book.map((r) => r.rowKey)).size).toBe(m.book.length);
    expect(row(4, "donor_share").rowKey).toBe("demo-f372326129.r1:4/demo-f372326129.diapers");
    expect([row(4, "donor_share").code, row(4, "donor_share").reason]).toEqual(["captured", null]);
    expect([row(10, "rejected").needShown, row(10, "rejected").paid, row(10, "rejected").code, row(10, "rejected").reason]).toEqual(["—", "—", "rejected", "Alcohol is not funded."]);
    expect(row(11, "rejected").reason).toBe("Gift cards are not funded by this drive.");
  });
});
