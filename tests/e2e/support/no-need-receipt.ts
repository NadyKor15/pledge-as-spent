import type { Recordings } from "../../../src/receipts/recorded";
import { receiptKey } from "../../../src/receipts/recorded";
import { noisePng, syntheticReceipt } from "../../app/support/synthetic";

// The server's case of 9 November as a recorded receipt: two water lines held for a person with no need named and
// no quantity, and a gift card refused. The coordinator must pick the need before approving them.

export const NO_NEED_SEED = 9101;

export const noNeedReceiptBytes = (): Buffer => Buffer.from(noisePng(NO_NEED_SEED));

export function registerNoNeedReceipt(rec: Recordings): void {
  const x = syntheticReceipt(rec, NO_NEED_SEED, [
    { needId: null, qty: 2, amount: 1716, verdict: "review", ruleCode: "unclear", confidence: 0.5 },
    { needId: null, qty: 1, amount: 5000, verdict: "rejected", ruleCode: "gift_card", confidence: 0.95 },
    { needId: null, qty: 1, amount: 138, verdict: "review", ruleCode: "unclear", confidence: 0.5 },
  ]);
  for (const c of rec.classifications[receiptKey(x.parsed)]) c.needQty = null;
}
