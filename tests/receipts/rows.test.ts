import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { OcrEngine, OcrLine, OcrWord } from "../../src/receipts/ocr";
import { halfWidthMarks, repairDigits, rereadDoubtfulRows, stretchedRow, zeroMisread } from "../../src/receipts/rows";
import { anchorPii, totalRow } from "../../src/receipts/pii";
import type { Rgba } from "../../src/receipts/prep";

const word = (text: string, x: number, y: number, w = 0.1): OcrWord => ({ text, box: { x, y, w, h: 0.02 } });
function row(y: number, words: [string, number, number?][], confidence = 95): OcrLine {
  const ws = words.map(([t, x, w]) => word(t, x, y, w));
  return { text: words.map(([t]) => t).join(" "), box: { x: ws[0].box.x, y, w: 0.8, h: 0.02 }, words: ws, confidence };
}
const white: Rgba = { width: 200, height: 400, data: new Uint8Array(200 * 400 * 4).fill(255) };

function engine(answers: Record<string, { text: string; confidence: number }> = {}, fallback = { text: "", confidence: 0 }) {
  const calls: Uint8Array[] = [];
  const e: OcrEngine & { calls: Uint8Array[] } = {
    calls,
    recognize: async () => [],
    recognizeRow: async (png) => {
      calls.push(png);
      return answers[String(calls.length)] ?? fallback;
    },
    close: async () => {},
  };
  return e;
}

describe("zeroMisread", () => {
  it("accepts a zero read as 1, 6, 8 or 9, a dropped final zero, and one extra digit at the end", () => {
    expect(zeroMisread("2926", "2026")).toBe(true);
    expect(zeroMisread("95", "05")).toBe(true);
    expect(zeroMisread("168", "108")).toBe(true);
    expect(zeroMisread("1098", "1000")).toBe(true);
    expect(zeroMisread("2", "20")).toBe(true);
    expect(zeroMisread("104", "10")).toBe(true);
  });
  it("refuses any other difference: the photo's copy is not trusted over the OCR on those", () => {
    expect(zeroMisread("980", "898")).toBe(false);
    expect(zeroMisread("798", "799")).toBe(false);
    expect(zeroMisread("100", "190")).toBe(false); // a 0 read as a real 9 is not this mistake's direction
    expect(zeroMisread("2", "30")).toBe(false);
    expect(zeroMisread("12", "1234")).toBe(false);
    expect(zeroMisread("5", "5")).toBe(false);
  });
});

describe("repairDigits", () => {
  const lines = [row(0.1, [["2926", 0.1], ["年", 0.2], ["11", 0.3], ["月", 0.4], ["95", 0.5], ["日", 0.6]]), row(0.2, [["乾電池", 0.1], ["2", 0.3], ["本入", 0.4], ["¥698", 0.8]]), row(0.3, [["¥980", 0.8]]), row(0.4, [["TOTAL", 0.1], ["¥1,678", 0.8]])];

  it("corrects zeros across rows, whatever way the two readings split them", () => {
    const { lines: out, repairs } = repairDigits(lines, ["2026年11月05日 (土)", "• 20• ¥698", "¥980 TOTAL", "¥1,678"]);
    expect(out[0].text).toBe("2026 年 11 月 05 日");
    expect(out[1].text).toBe("乾電池 20 本入 ¥698");
    expect(repairs).toEqual([{ from: "2926", to: "2026" }, { from: "95", to: "05" }, { from: "2", to: "20" }]);
  });

  it("keeps the OCR's number when the photo's copy disagrees in another way", () => {
    const { lines: out, repairs } = repairDigits(lines, ["2926年11月95日", "• 2• ¥698", "¥898", "¥1,678"]);
    expect(out[2].text).toBe("¥980");
    expect(repairs).toEqual([]);
  });

  it("changes nothing when the photo gave no numbers", () => {
    const { lines: out, repairs } = repairDigits(lines, []);
    expect(out.map((l) => l.text)).toEqual(lines.map((l) => l.text));
    expect(repairs).toEqual([]);
  });

  it("repairs two numbers of one row without shifting the second", () => {
    const l = [row(0.1, [["19", 0.1], ["x", 0.2], ["1698", 0.3]])];
    expect(repairDigits(l, ["10 x 1098"]).lines[0].text).toBe("10 x 1098");
  });
});

describe("rereadDoubtfulRows", () => {
  const rows = () => [
    row(0.1, [["ミナト生活館", 0.2]], 90),
    row(0.3, [["パビ", 0.1], ["-7", 0.2], ["アツ", 0.3], ["NM", 0.4], ["¥3,294", 0.8]], 60),
    row(0.4, [["さば味噌者缶詰", 0.1, 0.4], ["¥2,256※", 0.8]], 58),
    row(0.5, [["合計", 0.1], ["¥5,550", 0.8]], 90),
    row(0.7, [["DY", 0.1], ["Wy", 0.2], ["様", 0.3]], 34),
    row(0.8, [["会員番号", 0.1], ["3216", 0.5]], 93),
  ];

  it("takes a plainly katakana answer of about the same confidence for a doubtful row, and keeps the amount", async () => {
    const e = engine({ "1": { text: 'へ"ビーラブパンツ M', confidence: 58 }, "2": { text: "さば味噌看千誌", confidence: 46 }, "3": { text: "ミシマレン", confidence: 76 } });
    const out = await rereadDoubtfulRows(white, rows(), e, ["ja", "en"]);
    expect(out[1].text).toBe("ベビーラブパンツ M ¥3,294");
    expect(out[2].text).toBe("さば味噌者缶詰 ¥2,256※"); // kanji at a lower confidence: the first reading stays
    expect(out[4].text).toBe("ミシマレン");
    expect(e.calls).toHaveLength(3); // not the store's name, the total or a row with digits below the total
  });

  it("keeps a size the stretched row lost", async () => {
    const r = [row(0.3, [["ミ", 0.1], ["胞オケー", 0.2], ["2L", 0.4], ["¥648※", 0.8]], 60), row(0.5, [["TOTAL", 0.1], ["¥648", 0.8]], 90)];
    const out = await rereadDoubtfulRows(white, r, engine({ "1": { text: "ミネラルウォーターフL", confidence: 89 } }), ["ja", "en"]);
    expect(out[0].text).toBe("ミネラルウォーターフL 2L ¥648※");
  });

  it("does nothing for other languages or an engine without row reading", async () => {
    const e = engine();
    expect(await rereadDoubtfulRows(white, rows(), e, ["tr", "en"])).toEqual(rows());
    expect(e.calls).toHaveLength(0);
    const { recognizeRow: _, ...plain } = e;
    expect(await rereadDoubtfulRows(white, rows(), plain as OcrEngine, ["ja"])).toEqual(rows());
  });

  it("cuts the row out twice as wide and a third taller, and stays inside the image at its edges", () => {
    const png = PNG.sync.read(Buffer.from(stretchedRow(white, { x: 0.25, y: 0.5, w: 0.5, h: 0.05 })));
    expect(png.width).toBeGreaterThan(190);
    expect(png.height).toBeGreaterThan(25);
    expect(() => stretchedRow(white, { x: -0.1, y: 0.97, w: 1.2, h: 0.05 })).not.toThrow();
  });

  it("restores half-width marks", () => {
    expect(halfWidthMarks('へ"ビーラプ')).toBe("ベビーラプ");
    expect(halfWidthMarks('"ビーラプ  がッツ M')).toBe("ビーラプ がッツ M");
    expect(halfWidthMarks("^ビー")).toBe("ビー");
  });
});

describe("personal data by position", () => {
  const ja = [
    row(0.5, [["合計", 0.1], ["¥14,646", 0.8]]),
    row(0.55, [["クレ", 0.2], ["ジッ", 0.25], ["ト", 0.3], ["seco", 0.6], ["591", 0.8]]),
    row(0.6, [["お支払い", 0.1], ["¥14,646", 0.8]]),
    row(0.65, [["ポイントカード", 0.1]]),
    row(0.7, [["DY", 0.2], ["Wy", 0.3], ["様", 0.4]]),
    row(0.75, [["会員番号", 0.1], ["3216", 0.6], ["2141", 0.7], ["5525", 0.8]]),
    row(0.8, [["ご来店ありがとうございました", 0.1]]),
  ];

  it("finds the card, the name and the member id on a Japanese receipt, with boxes that leave the labels out", () => {
    const found = anchorPii(ja);
    expect(found.map((p) => p.kind).sort()).toEqual(["card_number", "member_id", "name"]);
    expect(found.find((p) => p.kind === "member_id")).toMatchObject({ text: "3216 2141 5525", bbox: { x: 0.6 } });
    expect(found.find((p) => p.kind === "card_number")).toMatchObject({ text: "seco 591", bbox: { x: 0.6 } });
    const name = found.find((p) => p.kind === "name")!;
    expect(name.text).toBe("DY Wy");
    expect(name.bbox!.x + name.bbox!.w).toBeCloseTo(0.4);
  });

  it("finds them on English, Spanish and Turkish layouts", () => {
    const en = [row(0.5, [["TOTAL", 0.1], ["$51.41", 0.8]]), row(0.55, [["VISA", 0.1], ["SRK", 0.5], ["2", 0.7], ["496", 0.8]]), row(0.6, [["APPROVED", 0.1], ["$51.41", 0.8]]), row(0.65, [["REWARDS", 0.1], ["MEMBER", 0.2]]), row(0.7, [["AVA", 0.1], ["PRESCOTT", 0.2]]), row(0.75, [["MEMBER", 0.1], ["#", 0.2], ["2899736096", 0.3]]), row(0.8, [["THANK", 0.1], ["YOU", 0.2]])];
    expect(anchorPii(en).map((p) => [p.kind, p.text]).sort()).toEqual([["card_number", "SRK 2 496"], ["member_id", "2899736096"], ["name", "AVA PRESCOTT"]]);
    const es = [row(0.5, [["TOTAL", 0.1], ["(IVA", 0.2], ["INCLUIDO)", 0.3], ["28,35", 0.7], ["EUR", 0.8]]), row(0.55, [["PAGO", 0.1], ["TARJETA", 0.2], ["28,35", 0.8]]), row(0.6, [["ao", 0.1], ["ek", 0.2], ["7636", 0.8]]), row(0.65, [["SOCIO", 0.1], ["6082753386", 0.7]]), row(0.7, [["MARCOS", 0.1], ["ALBERDI", 0.2]]), row(0.75, [["GRACIAS", 0.1], ["POR", 0.2], ["SU", 0.3], ["VISITA", 0.4]])];
    expect(anchorPii(es).map((p) => p.kind).sort()).toEqual(["card_number", "member_id", "name"]);
    const tr = [row(0.5, [["TOPLAM", 0.1], ["*367,61", 0.8]]), row(0.55, [["KREDİ", 0.1], ["KARTI", 0.2], ["*367,61", 0.8]]), row(0.6, [["eK", 0.1], ["aplik", 0.2], ["7374", 0.8]]), row(0.65, [["MÜŞTERİ", 0.1], ["KARTI", 0.2], ["7724103405", 0.7]]), row(0.7, [["AYŞE", 0.1], ["DEMİRKAN", 0.2]])];
    expect(anchorPii(tr).map((p) => [p.kind, p.text]).sort()).toEqual([["card_number", "eK aplik 7374"], ["member_id", "7724103405"], ["name", "AYŞE DEMİRKAN"]]);
  });

  it("finds nothing without a total row, and takes an amount or a phone for neither card nor name", () => {
    expect(anchorPii(ja.slice(1).map((l) => (l.text.startsWith("合計") ? row(0.5, [["x", 0.1]]) : l)))).toEqual([]);
    const r = [row(0.5, [["TOTAL", 0.1], ["$5.00", 0.8]]), row(0.55, [["CHANGE", 0.1], ["$5.00", 0.8]]), row(0.6, [["TEL", 0.1], ["555", 0.3], ["0100", 0.4]]), row(0.65, [["THANK", 0.1], ["YOU", 0.2]])];
    expect(anchorPii(r)).toEqual([]);
  });

  it("the total row is the last one, and a subtotal is not it", () => {
    const r = [row(0.1, [["小計", 0.1], ["¥5", 0.8]]), row(0.2, [["合計", 0.1], ["¥5", 0.8]]), row(0.3, [["TOTAL", 0.1], ["¥5", 0.8]])];
    expect(totalRow(r)).toBe(2);
    expect(totalRow([r[0]])).toBe(-1);
  });
});
