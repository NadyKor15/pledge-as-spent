import type { UpstreamRejection } from "../allocate";
import type { Drive, FundableLineInput, Need, Pledge } from "../types";

// The demo story: a flood in a fictional Japanese city. Three donors in three
// currencies back three needs, a company matches 1:1 up to JPY 500,000, and one
// tax-included supermarket receipt has 9 eligible lines and 2 refused ones.
// Rates are the scenario constants shared with the receipts module.

export const STORY_T0 = "2026-11-03T00:00:00.000Z";

export const STORY_RATES = { EURJPY: "162.35", USDJPY: "151.20" } as const;

export const storyDrive: Drive = {
  id: "kitasora-flood",
  title: "Kitasora flood relief",
  baseCurrency: "JPY",
  disasterDate: "2026-11-01",
  zone: ["北空市", "Kitasora"],
  rules: "Drinking water, baby diapers and AA batteries for the evacuation centre. No alcohol, tobacco or gift cards.",
  batch: { maxAgeHours: 24, thresholdMinor: { JPY: 50_000, EUR: 30_000, USD: 30_000 } },
  status: "open",
  createdAt: STORY_T0,
};

export const storyNeeds: Need[] = [
  { id: "water", driveId: storyDrive.id, label: "Drinking water 2 L", unit: "bottle", qtyNeeded: 40 },
  { id: "diapers", driveId: storyDrive.id, label: "Baby diapers size M", unit: "pack", qtyNeeded: 6 },
  { id: "batteries", driveId: storyDrive.id, label: "AA batteries", unit: "battery", qtyNeeded: 50 },
];

const pledge = (p: Omit<Pledge, "driveId" | "status" | "paypal"> & { orderId: string }): Pledge => {
  const { orderId, ...rest } = p;
  return { ...rest, driveId: storyDrive.id, status: "pending_approval", paypal: { orderId } };
};

export const storyPledges: Pledge[] = [
  pledge({
    id: "p-anna",
    kind: "donor",
    needId: "water",
    donorName: "Anna (Germany)",
    donorCountry: "DE",
    amount: { currency: "EUR", minor: 2000 },
    fx: { base: "JPY", quote: "EUR", rate: STORY_RATES.EURJPY, source: "scenario constant", asOf: "2026-11-03" },
    orderId: "ORDER-ANNA",
  }),
  pledge({
    id: "p-mike",
    kind: "donor",
    needId: "diapers",
    donorName: "Mike (USA)",
    donorCountry: "US",
    amount: { currency: "USD", minor: 3000 },
    fx: { base: "JPY", quote: "USD", rate: STORY_RATES.USDJPY, source: "scenario constant", asOf: "2026-11-03" },
    orderId: "ORDER-MIKE",
  }),
  pledge({
    id: "p-yuki",
    kind: "donor",
    needId: "batteries",
    donorName: "Yuki (Japan)",
    donorCountry: "JP",
    amount: { currency: "JPY", minor: 3000 },
    fx: { base: "JPY", quote: "JPY", rate: "1", source: "same currency", asOf: "2026-11-03" },
    orderId: "ORDER-YUKI",
  }),
  pledge({
    id: "p-match",
    kind: "match",
    needId: null,
    donorName: "Kitasora Logistics (company match)",
    donorCountry: "JP",
    amount: { currency: "JPY", minor: 500_000 },
    fx: { base: "JPY", quote: "JPY", rate: "1", source: "same currency", asOf: "2026-11-03" },
    match: { ratioNum: 1, ratioDen: 1 },
    orderId: "ORDER-MATCH",
  }),
];

export const STORY_RECEIPT_ID = "rcpt-kitasora-0001";

/** The 9 eligible lines, tax included, as the receipts module hands them over. */
export const storyFundableLines: FundableLineInput[] = [
  { receiptId: STORY_RECEIPT_ID, lineNo: 1, needId: "water", needQty: 4, amountBase: 432 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 2, needId: "water", needQty: 4, amountBase: 472 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 3, needId: "water", needQty: 4, amountBase: 396 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 4, needId: "diapers", needQty: 2, amountBase: 3278 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 5, needId: "diapers", needQty: 1, amountBase: 1958 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 6, needId: "batteries", needQty: 8, amountBase: 792 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 7, needId: "batteries", needQty: 8, amountBase: 748 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 8, needId: "batteries", needQty: 20, amountBase: 1628 },
  { receiptId: STORY_RECEIPT_ID, lineNo: 10, needId: "batteries", needQty: 2, amountBase: 220 },
];

/** The 2 lines the receipt checks refused. */
export const storyRejectedLines: UpstreamRejection[] = [
  {
    receiptId: STORY_RECEIPT_ID,
    lineNo: 9,
    needId: null,
    needQty: null,
    amountBase: 436,
    code: "alcohol",
    reasonEn: "Beer is alcohol; the drive does not fund alcohol.",
  },
  {
    receiptId: STORY_RECEIPT_ID,
    lineNo: 11,
    needId: null,
    needQty: null,
    amountBase: 3000,
    code: "gift_card",
    reasonEn: "A gift card is not a relief item.",
  },
];

/** Receipt total (tax included): 9,924 eligible + 3,436 refused. */
export const STORY_RECEIPT_TOTAL = 13_360;
