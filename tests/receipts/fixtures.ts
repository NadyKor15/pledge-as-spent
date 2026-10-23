import type { Drive, Need } from "../../src/core/types";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";

export function line(lineNo: number, amountMinor: number, taxRateBp: number | null = null): ParsedReceipt["lines"][number] {
  return { lineNo, rawText: `item ${lineNo}`, translationEn: `item ${lineNo}`, qty: 1, unitPriceMinor: amountMinor, amountMinor, taxRateBp };
}

export function receipt(over: Partial<ParsedReceipt> = {}): ParsedReceipt {
  const lines = over.lines ?? [line(1, 1000), line(2, 500)];
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  return {
    merchantName: "Test Store",
    merchantAddress: "1 Main St, Kitasora",
    country: "JP",
    currency: "JPY",
    purchasedAt: "2026-11-05T14:32:00",
    receiptNumber: "0001",
    lines,
    subtotalMinor: null,
    taxMinor: null,
    taxIncluded: true,
    totalMinor: sum,
    pii: [],
    readability: "good",
    ...over,
  };
}

export const drive: Drive = {
  id: "d1",
  title: "Test drive",
  baseCurrency: "JPY",
  disasterDate: "2026-11-02",
  zone: ["Kitasora", "北空"],
  rules: "No alcohol, tobacco or gift cards.",
  batch: { maxAgeHours: 24, thresholdMinor: {} },
  status: "open",
  createdAt: "2026-11-01T00:00:00Z",
};

export const needs: Need[] = [
  { id: "water", driveId: "d1", label: "Water 2 L", unit: "bottle", qtyNeeded: 40 },
  { id: "diapers", driveId: "d1", label: "Diapers M", unit: "pack", qtyNeeded: 6 },
];

export function cls(lineNo: number, over: Partial<LineClassification> = {}): LineClassification {
  return { lineNo, needId: "water", needQty: 1, verdict: "eligible", ruleCode: null, reasonEn: "ok", confidence: 0.95, ...over };
}
