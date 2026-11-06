import { describe, expect, it } from "vitest";
import { money, moneyIn, rateTextIn } from "@/ui/format";

// The Ledger speaks English, German or Japanese. money() does not change: the Telegram bot and the server
// print it, so its output is pinned here; the reader's language goes through moneyIn().

describe("money() stays as the bot and the server print it", () => {
  it("prints the same strings it always did", () => {
    expect(money("JPY", 10448)).toBe("¥10,448");
    expect(money("JPY", 1234567)).toBe("¥1,234,567");
    expect(money("EUR", 123456)).toBe("€1,234.56");
    expect(money("USD", 858)).toBe("$8.58");
    expect(money("USD", -858)).toBe("−$8.58");
    expect(money("GBP", 5)).toBe("£0.05");
    expect(money("CAD", 100)).toBe("CA$1.00");
    expect(money("AUD", 100)).toBe("A$1.00");
    expect(money("TRY", 12345)).toBe("TRY 123.45");
    expect(money("JPY", 0)).toBe("¥0");
    expect(money(null, 5)).toBe("");
    expect(money("JPY", null)).toBe("");
  });
});

describe("moneyIn(): amounts in the reader's language", () => {
  it("English is money() itself", () => {
    for (const [c, n] of [["JPY", 10448], ["EUR", 123456], ["USD", -858], ["GBP", 5], ["CAD", 100], ["AUD", 100]] as const) expect(moneyIn("en", c, n)).toBe(money(c, n));
  });

  it("German: the sign after the figure, a point for thousands, a comma for cents", () => {
    expect(moneyIn("de", "EUR", 123456)).toBe("1.234,56 €");
    expect(moneyIn("de", "USD", 858)).toBe("8,58 $");
    expect(moneyIn("de", "JPY", 10448)).toBe("10.448 ¥");
    expect(moneyIn("de", "EUR", -246)).toBe("−2,46 €");
  });

  it("Japanese: yen with no decimals and the narrow yen sign; other currencies keep their cents", () => {
    expect(moneyIn("ja", "JPY", 10448)).toBe("¥10,448");
    expect(moneyIn("ja", "USD", 858)).toBe("$8.58");
    expect(moneyIn("ja", "EUR", 246)).toBe("€2.46");
    expect(moneyIn("ja", "JPY", -1298)).toBe("−¥1,298");
  });

  it("the spaces Intl puts in are plain spaces, so a test or a search finds the text", () => {
    expect(moneyIn("de", "EUR", 100)).not.toMatch(/[  ]/);
  });

  it("nothing to print stays empty, in every language", () => {
    for (const lang of ["en", "de", "ja"] as const) {
      expect(moneyIn(lang, null, 5)).toBe("");
      expect(moneyIn(lang, "JPY", null)).toBe("");
    }
  });
});

describe("rates at pledge in the reader's language", () => {
  const fx = { base: "JPY", quote: "EUR", rate: "162.35" };
  it("one unit of the pledge's currency in the drive's", () => {
    expect(rateTextIn("en", fx)).toBe("€1 = ¥162.35");
    expect(rateTextIn("de", fx)).toBe("1 € = 162,35 ¥");
    expect(rateTextIn("ja", fx)).toBe("€1 = ¥162.35");
    expect(rateTextIn("en", { base: "JPY", quote: "JPY", rate: "1" })).toBeNull();
    expect(rateTextIn("en", null)).toBeNull();
  });
});
