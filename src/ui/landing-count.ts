import { money } from "./format";
import type { LedgerModel } from "./ledger/derive";

/**
 * The landing page's one line about the finished drive, from the Ledger's own figures (deriveLedger): what donors
 * pledged, what checked receipt lines took, what PayPal released and so never charged. Only on a closed drive where
 * every rest was released, never charged: otherwise there is no line rather than a claim that is not true.
 */
export function countLine(m: LedgerModel): string | null {
  if (m.phase !== "closed" || !m.allNeverCharged) return null;
  const c = (n: number) => money(m.baseCurrency, n);
  return `On the finished drive, donors pledged ${c(m.promised)}: ${c(m.spent)} paid for checked receipt lines, and ${c(m.returned)} was never charged.`;
}
