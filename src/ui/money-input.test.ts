import { describe, expect, it } from "vitest";
import { showMinor, toMinor } from "./money-input";

describe("money a donor types", () => {
  it("reads a comma or a dot before one or two final digits as the decimal mark (EUR, USD)", () => {
    expect(toMinor("20,50", "EUR")).toBe(2050); // not €2,050
    expect(toMinor("20.50", "EUR")).toBe(2050);
    expect(toMinor("0,80", "EUR")).toBe(80); // not €80
    expect(toMinor("0,8", "EUR")).toBe(80);
    expect(toMinor("20", "USD")).toBe(2000);
    expect(toMinor("1,00", "USD")).toBe(100);
  });

  it("reads groups of three digits split by a space, a no-break space, a comma, or a dot before a decimal comma", () => {
    expect(toMinor("1 234,56", "EUR")).toBe(123_456);
    expect(toMinor("1 234,56", "EUR")).toBe(123_456); // no-break space, as French keyboards and copies give it
    expect(toMinor("1 234,56", "EUR")).toBe(123_456); // narrow no-break space
    expect(toMinor("1.234,56", "EUR")).toBe(123_456);
    expect(toMinor("1,234.56", "USD")).toBe(123_456);
    expect(toMinor("2,500", "USD")).toBe(250_000);
    expect(toMinor("1 000", "EUR")).toBe(100_000);
    expect(toMinor("1,200", "JPY")).toBe(1200);
    expect(toMinor("1 200", "JPY")).toBe(1200);
    expect(toMinor("120", "JPY")).toBe(120);
  });

  it("refuses an empty field and what is not money", () => {
    for (const t of ["", " ", "abc", "-5", "1e3", "0x50", "€5", "5 €", "20,50 EUR", "２０", "1/2", "20..50", ",50", "20,", "+20"]) {
      expect(toMinor(t, "EUR")).toBeNull();
    }
  });

  it("refuses what could be read two ways, or mixes separators", () => {
    for (const t of ["1.000", "1.234", "1,234,56", "1.234.56", "0,800", "1,0000", "1 234.567", "12 34", "1, 234", "1,234 567"]) expect(toMinor(t, "EUR")).toBeNull();
    for (const t of ["1.5", "1,20", "12,00", "1.000", "1.200"]) expect(toMinor(t, "JPY")).toBeNull(); // whole yen only
  });

  it("keeps zero and the pledge ceiling out; a price per unit has no such ceiling", () => {
    expect(toMinor("0", "EUR")).toBeNull();
    expect(toMinor("0,00", "EUR")).toBeNull();
    expect(toMinor("10 000", "EUR")).toBe(1_000_000);
    expect(toMinor("10,000.01", "EUR")).toBeNull();
    expect(toMinor("10001", "JPY")).toBeNull();
    expect(toMinor("15000", "JPY", { ceiling: false })).toBe(15_000); // at most ¥15,000 a heater
    expect(toMinor("15 000,00", "EUR", { ceiling: false })).toBe(1_500_000);
    expect(toMinor("0", "JPY", { ceiling: false })).toBeNull();
  });

  it("shows the value as the server will take it", () => {
    expect(showMinor(80, "EUR")).toBe("€0.80");
    expect(showMinor(100_050, "USD")).toBe("$1,000.50");
    expect(showMinor(1200, "JPY")).toBe("¥1,200");
  });
});
