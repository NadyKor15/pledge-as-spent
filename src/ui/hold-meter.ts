import { holdAmounts } from "./derive";
import { moneyIn, type Lang } from "./format";
import { WORDS } from "./ledger/i18n";
import type { Hold } from "./types";

// One donor's hold as parts that add up to it, read from the book as holdAmounts reads it. The bar (HoldMeter) draws
// them; the statement, the money map, the donors' card and the book's cell all take the same parts.

/** The parts in the bar's order: charged first, then what may still be charged, then what never will be. */
export const METER_KEYS = ["charged", "waiting", "held", "returning", "never", "back"] as const;
export type MeterKey = (typeof METER_KEYS)[number];

export interface MeterParts extends Record<MeterKey, number> {
  currency: string;
  /** The hold: charged + waiting + held + returning + never + back. */
  total: number;
}

type MeterHold = Pick<Hold, "currency" | "pledged" | "authorized" | "captured" | "capturePending" | "accrued" | "released" | "uncollected" | "reversed" | "revoked" | "status">;

/** A hold that can no longer be captured: what it did not spend has left it. */
const OVER = new Set<Hold["status"]>(["voided", "expired", "captured", "denied"]);

/**
 * charged = PayPal took it (net of refunds); waiting = approved for a purchase, not taken yet; held = what the hold can
 * still pay; returning = on its way back after a withdrawal; never = released by PayPal, never charged (with shares
 * that could not be collected, once the hold is over: until its void PayPal keeps them on the hold); back = charged,
 * then refunded by PayPal.
 */
export function meterParts(h: MeterHold): MeterParts {
  const a = holdAmounts(h);
  const over = OVER.has(h.status);
  const uncollected = h.authorized > 0 ? h.uncollected : 0;
  return {
    currency: h.currency,
    total: a.total,
    charged: a.spent,
    waiting: a.waiting,
    held: a.held + (over || a.returning > 0 ? 0 : uncollected),
    returning: a.returning + (!over && a.returning > 0 ? uncollected : 0),
    never: a.released + (over ? uncollected : 0),
    back: h.authorized > 0 ? h.reversed : 0,
  };
}

/** The parts there are, in order, each with its share of the hold in percent (one decimal). */
export function meterSegments(p: MeterParts): { key: MeterKey; value: number; pct: number }[] {
  if (p.total <= 0) return [];
  return METER_KEYS.filter((k) => p[k] > 0).map((k) => ({ key: k, value: p[k], pct: Math.round((p[k] / p.total) * 1000) / 10 }));
}

/** "€4.58 spent, €15.42 never charged": the bar in words, for screen readers and a tooltip. */
export function meterLabel(p: MeterParts, lang: Lang): string {
  const w = WORDS[lang].meterWord;
  return meterSegments(p)
    .map((s) => `${moneyIn(lang, p.currency, s.value)} ${w[s.key]}`)
    .join(lang === "ja" ? "、" : ", ");
}
