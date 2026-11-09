import { describe, expect, it } from "vitest";
import { itemPhrase, ofCount, qtyText } from "./format";

describe("counts with their unit", () => {
  it("puts the unit's noun in the plural after a count above one", () => {
    expect(qtyText(28, "bottle 2 L")).toBe("28 bottles");
    expect(qtyText(6, "pack")).toBe("6 packs");
    expect(qtyText(3, "gallon jug")).toBe("3 jugs");
    expect(qtyText(4, "box")).toBe("4 boxes");
    expect(qtyText(2, "battery")).toBe("2 batteries");
  });

  it("keeps the singular for one", () => {
    expect(qtyText(1, "bottle 2 L")).toBe("1 bottle");
    expect(qtyText(1, "pack")).toBe("1 pack");
    expect(qtyText(1, "battery")).toBe("1 battery");
  });

  it("gives pieces no unit word", () => {
    expect(qtyText(50, "piece")).toBe("50");
    expect(ofCount(12, 50, "piece")).toBe("12 of 50");
  });

  it("uses the same rule in the other phrasings", () => {
    expect(ofCount(12, 40, "bottle 2 L")).toBe("12 of 40 bottles");
    expect(itemPhrase(6, "pack", "Baby diapers size M")).toBe("6 packs of baby diapers size M");
  });
});
