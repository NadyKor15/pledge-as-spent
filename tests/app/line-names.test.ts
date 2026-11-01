import { describe, expect, it } from "vitest";
import { lineName, type LineView } from "../../src/ui/derive";

const line = (over: Partial<LineView["line"]>) =>
  ({ lineNo: 1, text: "北空の天然水 2L", translationEn: "", amount: 100, verdict: "eligible", needId: null, needQty: null, ruleCode: null, reasonEn: null, confidence: 0.9, ...over }) as LineView["line"];
const water = { displayLabel: "Water 2 L" } as LineView["need"];

describe("what a printed line is called", () => {
  it("leads with the need's label and keeps the model's translation and the printed text", () => {
    expect(lineName({ line: line({ translationEn: "Natural water 2L" }), need: water })).toEqual({ title: "Water 2 L", detail: "Natural water 2L", original: "北空の天然水 2L" });
  });

  it("works when the model gave no translation", () => {
    expect(lineName({ line: line({}), need: water })).toEqual({ title: "Water 2 L", detail: "", original: "北空の天然水 2L" });
  });

  it("names a refused line by its rule and hides a misread translation", () => {
    const n = lineName({ line: line({ text: "缶ピール 350m 6 缶", translationEn: "Canned peel 350ml 6 cans", ruleCode: "alcohol" }), need: undefined });
    expect(n).toEqual({ title: "Alcohol", detail: "", original: "缶ピール 350m 6 缶" });
    expect(lineName({ line: line({ translationEn: "Gift card 3000", ruleCode: "gift_card" }), need: undefined }).title).toBe("Gift card");
  });

  it("falls back to the translation, then to the printed text, and invents nothing", () => {
    expect(lineName({ line: line({ translationEn: "Bandages" }), need: undefined }).title).toBe("Bandages");
    expect(lineName({ line: line({}), need: undefined })).toEqual({ title: "北空の天然水 2L", detail: "", original: "" });
  });
});
