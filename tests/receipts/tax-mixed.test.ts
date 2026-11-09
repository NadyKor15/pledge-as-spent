import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Drive, Need } from "../../src/core/types";
import { allocateTax, checkReceipt, toFundableLines } from "../../src/receipts/checks";
import { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { demoDrive } from "../../src/server/demo";
import { cls, drive, line, receipt } from "./fixtures";

// Tax added on top of a receipt with more than one rate, when the reading prints the rate on some lines only.
// A Japanese receipt marks the reduced-rate lines (※, 8 %) and leaves the standard-rate lines (10 %) unmarked; a US
// receipt marks the taxable lines and leaves the exempt ones unmarked. A donor must never pay another line's tax.

/** Countries the generator draws from: the rates a line may truly carry. */
const COUNTRIES = [
  { country: "JP", currency: "JPY", rates: [800, 1000] },
  { country: "TR", currency: "TRY", rates: [100, 1000, 2000] },
  { country: "US", currency: "USD", rates: [0, 600, 725, 750] },
] as const;

/** The fixture drive in the receipt's currency (the drive type knows the demo's currencies only; the checks compare codes). */
const driveFor = (currency: string): Drive => ({ ...drive, baseCurrency: currency as Drive["baseCurrency"] });

type Rounding = "floor" | "round" | "ceil";
const roundTax = (base: bigint, rate: number, how: Rounding): bigint => {
  const num = base * BigInt(rate);
  const q = num / BigInt(10000);
  const rem = num % BigInt(10000);
  if (rem === BigInt(0)) return q;
  if (how === "floor") return q;
  if (how === "ceil") return q + BigInt(1);
  return rem * BigInt(2) >= BigInt(10000) ? q + BigInt(1) : q;
};

interface GenLine {
  amount: number;
  /** A discount right after it, as a positive number (printed negative). */
  discount: number;
  rate: number;
  printed: boolean;
  discountPrinted: boolean;
}

const genReceipt = fc
  .record({
    c: fc.integer({ min: 0, max: COUNTRIES.length - 1 }),
    how: fc.constantFrom<Rounding>("floor", "round", "ceil"),
    lines: fc.array(
      fc.record({
        amount: fc.integer({ min: 1, max: 60000 }),
        discountPct: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 90 })),
        rateIndex: fc.nat(),
        printed: fc.boolean(),
        discountPrinted: fc.boolean(),
      }),
      { minLength: 1, maxLength: 8 },
    ),
    // US receipts use one local rate for all taxable lines.
    usRate: fc.constantFrom(600, 725, 750),
    allUnprinted: fc.boolean(),
  })
  .map(({ c, how, lines, usRate, allUnprinted }) => {
    const country = COUNTRIES[c];
    const pick = (i: number) => (country.country === "US" ? (i % 2 === 0 ? 0 : usRate) : country.rates[i % country.rates.length]);
    let gl: GenLine[] = lines.map((l) => ({
      amount: l.amount,
      discount: Math.floor((l.amount * l.discountPct) / 100),
      rate: pick(l.rateIndex),
      printed: l.printed,
      discountPrinted: l.discountPrinted,
    }));
    if (allUnprinted) {
      // A reading with no rate at all: only a receipt of one rate is in this branch (with no rate printed, the code
      // cannot see that rates are mixed; that case is outside this property and is named in the report).
      const r = gl[0].rate;
      gl = gl.map((l) => ({ ...l, rate: r, printed: false, discountPrinted: false }));
    } else if (!gl.some((l) => l.printed)) {
      gl[0] = { ...gl[0], printed: true };
    }
    return { country, how, gl };
  });

function build(country: (typeof COUNTRIES)[number], how: Rounding, gl: GenLine[]) {
  const lines: ParsedReceipt["lines"] = [];
  /** Per head line: its print index, its lines' indexes and its exact tax times 10000. */
  const heads: { lineNo: number; idx: number[]; net: number; exactTimes10k: bigint }[] = [];
  const bases = new Map<number, bigint>();
  for (const g of gl) {
    const lineNo = lines.length + 1;
    lines.push({ ...line(lineNo, g.amount, g.printed ? g.rate : null) });
    const idx = [lines.length - 1];
    let net = g.amount;
    if (g.discount > 0) {
      lines.push({ ...line(lines.length + 1, -g.discount, g.discountPrinted ? g.rate : null), qty: null, unitPriceMinor: null });
      idx.push(lines.length - 1);
      net -= g.discount;
    }
    bases.set(g.rate, (bases.get(g.rate) ?? BigInt(0)) + BigInt(net));
    heads.push({ lineNo, idx, net, exactTimes10k: BigInt(net) * BigInt(g.rate) });
  }
  let tax = BigInt(0);
  for (const [rate, base] of bases) tax += roundTax(base, rate, how);
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const r = receipt({
    country: country.country,
    currency: country.currency,
    lines,
    subtotalMinor: sum,
    taxMinor: Number(tax),
    taxIncluded: false,
    totalMinor: sum + Number(tax),
  });
  const needs: Need[] = heads.map((h) => ({ id: `n${h.lineNo}`, driveId: drive.id, label: `Need ${h.lineNo}`, unit: "item", qtyNeeded: 1 }));
  const classes = heads.map((h) => cls(h.lineNo, { needId: `n${h.lineNo}`, needQty: 1, confidence: 1 }));
  const printedRates = new Set(lines.map((l) => l.taxRateBp).filter((x) => x !== null));
  return { r, needs, classes, heads, trueRates: bases.size, printedRates: printedRates.size };
}

describe("tax on top with mixed rates and rates missing on some lines", () => {
  it("property: a line never pays more than its price and its own tax, and a receipt never more than its total", () => {
    fc.assert(
      fc.property(genReceipt, ({ country, how, gl }) => {
        const { r, needs, classes, heads, trueRates, printedRates } = build(country, how, gl);
        const out = toFundableLines(r, classes, needs, driveFor(country.currency), {}, { receiptId: "x" });
        // The receipt rounds each rate's tax once: that unit falls on some line, so a line may carry one more unit
        // per rate than its own exact tax (per rate printed and per rate truly charged), and one for the split's rounding.
        const slack = BigInt(trueRates + printedRates + 1);
        for (const f of out.fundable) {
          const h = heads.find((x) => x.lineNo === f.lineNo)!;
          const ceilExact = (h.exactTimes10k + BigInt(9999)) / BigInt(10000);
          expect(BigInt(f.amountBase), `line ${f.lineNo}`).toBeLessThanOrEqual(BigInt(h.net) + ceilExact + slack);
        }
        expect(out.fundable.reduce((s, f) => s + f.amountBase, 0)).toBeLessThanOrEqual(r.totalMinor);
        const shares = allocateTax(r);
        if (shares !== null) expect(shares.reduce((s, x) => s + x, 0)).toBe(r.taxMinor);
      }),
      { numRuns: 3000 },
    );
  });

  it("property: a line whose tax is unknown is held for a person, never funded with someone else's tax", () => {
    fc.assert(
      fc.property(genReceipt, ({ country, how, gl }) => {
        const { r, needs, classes } = build(country, how, gl);
        const out = toFundableLines(r, classes, needs, driveFor(country.currency), {}, { receiptId: "x" });
        const held = out.rejected.filter((x) => x.code === "tax_unknown").map((x) => x.lineNo);
        if (!held.length) return;
        expect(allocateTax(r)).toBeNull();
        const flags = checkReceipt({ receipt: r, drive: driveFor(country.currency), classifications: classes });
        const f = flags.find((x) => x.code === "tax_unknown");
        expect(f?.severity).toBe("review");
        for (const n of held) expect(f!.messageEn).toContain(String(n));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("holdout2-ja-02: water at 8 % beside sake and diapers at 10 % that print no rate", () => {
  const cassette = JSON.parse(readFileSync(new URL("../../eval/live/meta-h2/holdout2-ja-02.json", import.meta.url), "utf8")) as { reading: unknown; classifications: unknown };
  const reading = ParsedReceipt.parse(cassette.reading);
  const classifications = LineClassification.array().parse(cassette.classifications);
  const { drive: kitasora, needs } = demoDrive("demo-x", "2026-11-03T00:00:00Z");

  it("the reading has the rate on the 8 % lines only", () => {
    expect(reading.lines.map((l) => l.taxRateBp)).toEqual([800, 800, null, 800, 800, null]);
    expect(reading.taxMinor).toBe(345);
  });

  it("charges ¥472 of water with its own 8 %: about ¥510, not ¥636", () => {
    const out = toFundableLines(reading, classifications, needs, kitasora, {}, { receiptId: "demo-x.r2" });
    const water = out.fundable.find((f) => f.lineNo === 1)!;
    expect(water.needId).toBe("water");
    expect(water.amountBase).toBeGreaterThanOrEqual(509);
    expect(water.amountBase).toBeLessThanOrEqual(510);
    expect(out.fundable).toHaveLength(1);
    expect(out.rejected.map((x) => x.code)).not.toContain("tax_unknown");
  });

  it("the refused lines show their own tax too: noodles ≈ ¥181, mackerel with its coupon ≈ ¥384", () => {
    const s = allocateTax(reading)!;
    // 168 x 1.08 = 181.44; (396 - 40) x 1.08 = 384.48 (on the live upload they read ¥226 and ¥533).
    expect(168 + s[1]).toBeGreaterThanOrEqual(181);
    expect(168 + s[1]).toBeLessThanOrEqual(182);
    expect(396 - 40 + s[3] + s[4]).toBeGreaterThanOrEqual(384);
    expect(396 - 40 + s[3] + s[4]).toBeLessThanOrEqual(385);
  });

  it("puts the 10 % on the lines that print no rate: sake and diapers carry ¥266 between them", () => {
    const s = allocateTax(reading)!;
    expect(s.reduce((a, b) => a + b, 0)).toBe(345);
    expect(s[2] + s[5]).toBe(266);
    expect(s[0]).toBeGreaterThanOrEqual(37);
    expect(s[0]).toBeLessThanOrEqual(38);
  });
});

describe("rates that cannot be told apart", () => {
  it("holds the unmarked lines for a person and funds the marked ones with their own tax only", () => {
    // ¥1,000 at 8 % and ¥1,000 printed without a rate; the tax ¥135 fits neither 0 % (80) nor 10 % (180) on the second line.
    const r = receipt({ lines: [line(1, 1000, 800), line(2, 1000, null)], taxIncluded: false, taxMinor: 135, totalMinor: 2135 });
    const out = toFundableLines(r, [cls(1, { needQty: 1 }), cls(2, { needId: "diapers", needQty: 1 })], [{ id: "water", driveId: "d1", label: "Water", unit: "bottle", qtyNeeded: 40 }, { id: "diapers", driveId: "d1", label: "Diapers", unit: "pack", qtyNeeded: 6 }], drive, {}, { receiptId: "r" });
    expect(out.fundable).toEqual([{ receiptId: "r", lineNo: 1, needId: "water", needQty: 1, amountBase: 1080 }]);
    expect(out.rejected).toMatchObject([{ lineNo: 2, code: "tax_unknown" }]);
    expect(out.rejected[0].reasonEn).toMatch(/more than one tax rate/);
    expect(allocateTax(r)).toBeNull();
    const flags = checkReceipt({ receipt: r, drive, classifications: [cls(1), cls(2, { needId: "diapers" })] });
    expect(flags.find((f) => f.code === "tax_unknown")).toMatchObject({ severity: "review" });
  });

  it("a coordinator may release such a line: only its printed price is funded, never a share of tax", () => {
    const r = receipt({ lines: [line(1, 1000, 800), line(2, 1000, null)], taxIncluded: false, taxMinor: 135, totalMinor: 2135 });
    const out = toFundableLines(r, [cls(1, { needQty: 1 }), cls(2, { needId: "diapers", needQty: 1 })], [{ id: "water", driveId: "d1", label: "Water", unit: "bottle", qtyNeeded: 40 }, { id: "diapers", driveId: "d1", label: "Diapers", unit: "pack", qtyNeeded: 6 }], drive, {}, {
      receiptId: "r",
      coordinatorApproved: { by: "c", reason: "checked by hand", lineNos: [2] },
    });
    expect(out.fundable.map((f) => [f.lineNo, f.amountBase])).toEqual([
      [1, 1080],
      [2, 1000],
    ]);
  });

  it("does not flag a receipt whose unknown lines are refused anyway", () => {
    const r = receipt({ lines: [line(1, 1000, 800), line(2, 1000, null)], taxIncluded: false, taxMinor: 135, totalMinor: 2135 });
    const flags = checkReceipt({ receipt: r, drive, classifications: [cls(1), cls(2, { verdict: "rejected", needId: null, ruleCode: "alcohol" })] });
    expect(flags.map((f) => f.code)).not.toContain("tax_unknown");
  });
});
