import type { LedgerState } from "./ledger";

// Batching saves PayPal's fixed per-capture fee on every share after the first
// one in a batch. The fixed part depends on the currency.

export interface FixedFee {
  /** Minor units of the currency itself. */
  minor: number;
  source: string;
  asOf: string;
  /** true until checked against PayPal's published US fee page or real sandbox captures. */
  estimate: boolean;
}

const UNVERIFIED =
  "PayPal US merchant fees, fixed fee per commercial transaction by currency: recalled, not re-checked against the live page";

export const FIXED_FEES: Readonly<Record<string, FixedFee>> = {
  USD: {
    minor: 49,
    source:
      "Sandbox captures 2026-10-23 (docs/platform-findings.md #4): USD 11.10 -> 0.78, 6.00 -> 0.65, 12.90 -> 0.82 = 2.59% + USD 0.49",
    asOf: "2026-10-23",
    estimate: false,
  },
  EUR: {
    minor: 39,
    source: "Sandbox captures 2026-10-23 (docs/platform-findings.md #4): EUR 7.40 -> 0.58, 5.00 -> 0.52 = 2.59% + EUR 0.39",
    asOf: "2026-10-23",
    estimate: false,
  },
  GBP: { minor: 39, source: UNVERIFIED, asOf: "2026-10-23", estimate: true },
  CAD: { minor: 59, source: UNVERIFIED, asOf: "2026-10-23", estimate: true },
  AUD: { minor: 59, source: UNVERIFIED, asOf: "2026-10-23", estimate: true },
  JPY: {
    minor: 49,
    source: "Sandbox captures 2026-10-23 (docs/platform-findings.md #4): JPY 1110 -> 78, 500 -> 62, 12000 -> 360, 8000 -> 256 = 2.59% + JPY 49",
    asOf: "2026-10-23",
    estimate: false,
  },
  HUF: { minor: 149, source: UNVERIFIED, asOf: "2026-10-23", estimate: true },
  TWD: { minor: 14, source: UNVERIFIED, asOf: "2026-10-23", estimate: true },
};

export interface FeeSavings {
  currency: string;
  /** Confirmed capture batches. */
  batches: number;
  /** Shares those batches carried. */
  shares: number;
  /** (shares - batches) x fixed fee; null when the table has no fee for the currency. */
  savedMinor: number | null;
  estimate: boolean;
  source: string;
  /** Sum of paypal_fee PayPal reported, over the batches that reported one. */
  paypalFeeMinor: number;
  batchesWithReportedFee: number;
}

/** Per currency: sum over confirmed batches of (shares in batch - 1) x fixed fee. */
export function feeSavings(s: LedgerState, table: Readonly<Record<string, FixedFee>> = FIXED_FEES): FeeSavings[] {
  const rows = new Map<string, FeeSavings>();
  for (const id of s.pledgeIds) {
    const currency = s.pledges[id].amount.currency;
    for (const b of s.holds[id].batches) {
      if (b.status !== "confirmed") continue;
      const fee = Object.hasOwn(table, currency) ? table[currency] : undefined;
      const row = rows.get(currency) ?? {
        currency,
        batches: 0,
        shares: 0,
        savedMinor: fee ? 0 : null,
        estimate: fee ? fee.estimate : true,
        source: fee ? fee.source : "no fixed fee on record for this currency",
        paypalFeeMinor: 0,
        batchesWithReportedFee: 0,
      };
      row.batches += 1;
      row.shares += b.shares.length;
      if (fee && row.savedMinor !== null) row.savedMinor += (b.shares.length - 1) * fee.minor;
      if (b.paypalFeeMinor !== undefined) {
        row.paypalFeeMinor += b.paypalFeeMinor;
        row.batchesWithReportedFee += 1;
      }
      rows.set(currency, row);
    }
  }
  return [...rows.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1));
}
