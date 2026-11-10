// Shared domain types. Other modules (paypal, receipts, app) depend on Money,
// CurrencyCode, Drive, Need and Pledge: extend them, do not rename their fields.
// The money engine is pure: state + event -> state, state -> commands. It never
// calls PayPal and never asks a model about amounts.

export type CurrencyCode = "USD" | "EUR" | "JPY" | "GBP" | "CAD" | "AUD";

/** An amount in integer minor units (cents; whole yen for JPY). */
export interface Money {
  currency: CurrencyCode;
  minor: number;
}

/** 1 unit of `quote` (major) = `rate` units of `base` (major), e.g. 1 EUR = "162.35" JPY. */
export interface FxRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: string;
  source: string;
  asOf: string;
}

export interface BatchPolicy {
  /** Accrued shares are captured at the latest this many hours after the oldest one. */
  maxAgeHours: number;
  /** ...or as soon as the accrued amount on one hold reaches this, per currency. */
  thresholdMinor: Partial<Record<CurrencyCode, number>>;
}

export interface Drive {
  id: string;
  title: string;
  baseCurrency: CurrencyCode;
  /** ISO date; receipts dated earlier are flagged for the coordinator. */
  disasterDate: string;
  /** Places where purchases are expected (prefecture, city). */
  zone: string[];
  /** The drive's rules in plain words, read by the line classifier. */
  rules: string;
  batch: BatchPolicy;
  status: "open" | "closing" | "closed";
  createdAt: string;
}

export interface Need {
  id: string;
  driveId: string;
  label: string;
  /** Unit the quantity is counted in, e.g. "bottle 2 L", "pack". */
  unit: string;
  qtyNeeded: number;
}

export type PledgeKind = "donor" | "match";

export type HoldStatus =
  | "pending_approval"
  | "authorized"
  | "partially_captured"
  | "captured"
  | "voided"
  | "expired"
  | "denied";

export interface Pledge {
  id: string;
  driveId: string;
  kind: PledgeKind;
  /** Donor pledges back one need; a match pledge backs the whole drive. */
  needId: string | null;
  donorName: string;
  donorCountry?: string;
  /** The authorized amount, in the donor's currency. */
  amount: Money;
  /** Locked when the pledge is made: quote = pledge currency, base = drive currency. */
  fx: FxRate;
  /** Match pledges only: the match adds ratioNum/ratioDen per unit of donor money. */
  match?: { ratioNum: number; ratioDen: number };
  paypal: { orderId: string; authorizationId?: string };
  status: HoldStatus;
  authorizedAt?: string;
  honorUntil?: string;
  expiresAt?: string;
  reauthorizedAt?: string;
  /** How the donor approved the hold; only PayPal-account holds can be reauthorized. */
  paymentSource?: PaymentSource;
  /**
   * The donor's choice at the pledge for what is left once their need is covered:
   * "release" (absent means the same) lets it go at the close; "carry" keeps it for
   * this drive's next purchases, moving it to the open need that lacks the most.
   * Donor pledges only.
   */
  rest?: RestChoice;
}

export type RestChoice = "release" | "carry";

export type PaymentSource = "paypal" | "card";

/**
 * One approved receipt line, as the receipts module hands it to the engine.
 * Mirrors `FundableLine` in src/receipts/types.ts field for field, declared here
 * so the engine does not depend on the receipts module.
 */
export interface FundableLineInput {
  receiptId: string;
  lineNo: number;
  needId: string;
  /** Quantity in the need's unit, whole units. */
  needQty: number;
  /** Line amount in the drive's base currency, minor units, tax share included. */
  amountBase: number;
}
