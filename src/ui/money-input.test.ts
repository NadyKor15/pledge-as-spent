import { describe, expect, it } from "vitest";
import { showMinor, toMinor } from "./money-input";

describe("money a donor types", () => {
  it("reads a comma before one or two final digits as the decimal mark (EUR, USD)", () => {
    expect(toMinor("0,80", "EUR")).toBe(80); // not €80
    expect(toMinor("0,8", "EUR")).toBe(80);
    expect(toMinor("20,50", "EUR")).toBe(2050); // not €2,050
    expect(toMinor("20.50", "USD")).toBe(2050);
    expect(toMinor("1,00", "USD")).toBe(100);
  });

  it("reads a comma before groups of three digits as thousands", () => {
    expect(toMinor("1,000", "EUR")).toBe(100_000);
    expect(toMinor("1,000.50", "USD")).toBe(100_050);
    expect(toMinor("1,000,50", "EUR")).toBe(100_050);
    expect(toMinor("1,200", "JPY")).toBe(1200);
    expect(toMinor("120", "JPY")).toBe(120);
  });

  it("refuses what could be read two ways, or is not money", () => {
    for (const t of ["1.000", "1,0000", "0,800", "1.2.3", "", " ", "-5", "1e3", "0x50", "€5", "5 €", "abc"]) expect(toMinor(t, "EUR")).toBeNull();
    for (const t of ["1.5", "1,20", "12,00", "1.000"]) expect(toMinor(t, "JPY")).toBeNull(); // whole yen only
  });

  it("keeps zero and the ceiling out", () => {
    expect(toMinor("0", "EUR")).toBeNull();
    expect(toMinor("0,00", "EUR")).toBeNull();
    expect(toMinor("10,000", "EUR")).toBe(1_000_000);
    expect(toMinor("10,000.01", "EUR")).toBeNull();
    expect(toMinor("10001", "JPY")).toBeNull();
  });

  it("shows the value as the server will take it", () => {
    expect(showMinor(80, "EUR")).toBe("€0.80");
    expect(showMinor(100_050, "USD")).toBe("$1,000.50");
    expect(showMinor(1200, "JPY")).toBe("¥1,200");
  });
});
