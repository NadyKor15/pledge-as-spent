import { describe, expect, it } from "vitest";
import { RefiningClassifier, deriveNeedQty, forbiddenCategory, packCount, refineClassifications } from "../../src/receipts/quantity";
import { toFundableLines } from "../../src/receipts/checks";
import { cls, drive, line, needs, receipt } from "./fixtures";

const L = (rawText: string, qty: number | null, amount = 1000) => ({ ...line(1, amount), rawText, qty });

describe("pack size from the name", () => {
  it("reads the pack count in the four languages", () => {
    const cases: [string, number | null][] = [
      ["アルカリ乾電池 単3 20本入", 20], ["水 2L 6本ケース", 6], ["ツナ缶 3缶パック", 3], ["単3 ばら", null], ["ミネラルウォーター 2L", null],
      ["AA PİL 10'LU PAKET", 10], ["SEVİMLİ NO:4 JUMBO 42'Lİ", 42], ["KAYNAK SU 5 LT", null],
      ["PILAS AA LR6 8U", 8], ["AGUA 1,5L PACK 6", 6], ["AGUA MINERAL 1,5L", null],
      ["AA ALKALINE 24PK", 24], ["PURE WTR 1GAL 4CT", 4], ["SPRING WATER 1GAL", null], ["FLEECE THROW", null],
    ];
    for (const [t, n] of cases) expect(packCount(t), t).toBe(n);
  });
});

describe("needQty from the printed row", () => {
  const unit = (u: string) => ({ unit: u });
  it("multiplies the printed quantity by the pack size for piece, bottle and can needs", () => {
    expect(deriveNeedQty(L("アルカリ乾電池 単3 20本入", 1), unit("piece"))).toBe(20);
    expect(deriveNeedQty(L("単3電池 10本入", 2), unit("piece"))).toBe(20);
    expect(deriveNeedQty(L("単3 ばら", 10), unit("piece"))).toBe(10);
    expect(deriveNeedQty(L("北空の天然水 2L 6本ケース", 1), unit("bottle 2 L"))).toBe(6);
    expect(deriveNeedQty(L("ツナ缶 3缶パック", 4), unit("can"))).toBe(12);
    expect(deriveNeedQty(L("PURE WTR 1GAL 4CT", 2), unit("gallon jug"))).toBe(8);
    expect(deriveNeedQty(L("AA ALKALINE 24PK", null), unit("piece"))).toBe(24);
  });
  it("counts diapers in packs, not sheets", () => {
    expect(deriveNeedQty(L("ソフトキッズ おむつ M 44枚", 2), unit("pack"))).toBe(2);
    expect(deriveNeedQty(L("PAÑAL BEBÉ T3 44U", 3), unit("pack"))).toBe(3);
    expect(deriveNeedQty(L("DIAPERS SZ3 66CT", null), unit("pack"))).toBe(1);
  });
  it("says nothing when the row does not", () => {
    expect(deriveNeedQty(L("毛布 シングル", null), unit("piece"))).toBeNull();
    expect(deriveNeedQty(L("x", 1.5), unit("piece"))).toBeNull();
    expect(deriveNeedQty(L("x", 0), unit("piece"))).toBeNull();
  });
});

describe("forbidden categories by name", () => {
  it("finds alcohol, tobacco and gift cards in four languages and leaves everything else", () => {
    const yes: [string, string][] = [["缶ビール 350ml", "alcohol"], ["日本酒 720ml", "alcohol"], ["RAKI 70 CL", "alcohol"], ["VINO TINTO", "alcohol"], ["LAGER 6PK", "alcohol"], ["YILDIZ SİGARA", "tobacco"], ["TABACO LIAR", "tobacco"], ["CIGARETTES", "tobacco"], ["たばこ", "tobacco"], ["ギフトカード 3,000円", "gift_card"], ["TARJETA REGALO 50", "gift_card"], ["HEDİYE KARTI 500 TL", "gift_card"], ["GIFT CARD $25", "gift_card"], ["商品券", "gift_card"]];
    for (const [t, k] of yes) expect(forbiddenCategory(t), t).toBe(k);
    for (const t of ["ノンアルコールビール", "ROOT BEER", "ALKOLSÜZ BİRA", "ACEITE DE OLIVA", "MILK 1GAL", "BRINDLE BATTERY", "RINGER SOAP", "ALEXA SPEAKER", "雪解けの水 2L", "PILAS AA"]) expect(forbiddenCategory(t), t).toBeNull();
  });
});

describe("refining a classifier's answer", () => {
  const water = needs[0];
  const r = receipt({ lines: [L("北空の天然水 6本ケース", 1, 800), { ...L("缶ビール", 1, 1200), lineNo: 2 }, { ...L("毛布", null, 500), lineNo: 3 }, { ...line(4, -100), rawText: "値引" }], totalMinor: 2400 });
  const labels = [cls(1, { needQty: 1 }), cls(2, { needQty: 1 }), cls(3, { needId: "water", needQty: 2 }), cls(4)];

  it("takes the quantity from the row, rejects a drink by name whatever the classifier said, and falls back to the classifier", () => {
    const out = refineClassifications(r, needs, labels);
    expect(out[0]).toMatchObject({ verdict: "eligible", needId: "water", needQty: 6 });
    expect(out[1]).toMatchObject({ verdict: "rejected", ruleCode: "alcohol", needId: null, needQty: null });
    expect(out[2].needQty).toBe(2); // the row says nothing: the classifier's number stays
    expect(out[3]).toEqual(labels[3]); // a discount is left alone
    expect(water.id).toBe("water");
  });
  it("keeps a rejected line's own rule code when it already names the right one", () => {
    const l = [cls(1), cls(2, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol", reasonEn: "Beer.", confidence: 0.5 }), cls(3), cls(4)];
    expect(refineClassifications(r, needs, l)[1]).toEqual(l[1]);
  });
  it("wraps a classifier", async () => {
    const inner = { classify: async () => ({ lines: labels, usage: { model: "m", tokensIn: 1, tokensOut: 1, usdCeiling: 0, usdActual: 0 } }) };
    const out = await new RefiningClassifier(inner).classify({ receipt: r, needs, rules: "" });
    expect(out.lines[0].needQty).toBe(6);
    expect(out.usage.tokensIn).toBe(1);
  });
  it("funds one case of six as six bottles through the whole path", () => {
    const rr = receipt({ lines: [L("北空の天然水 6本ケース", 1, 800)], totalMinor: 800 });
    const refined = refineClassifications(rr, needs, [cls(1, { needQty: 40 })]); // the classifier overclaimed
    const out = toFundableLines(rr, refined, needs, drive, {}, { receiptId: "r" });
    expect(out.fundable).toMatchObject([{ needQty: 6, amountBase: 800 }]);
  });
});
