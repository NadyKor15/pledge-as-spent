import { CoreError } from "./errors";

// Time always comes in as an argument. Only zoned ISO strings are accepted:
// a zoneless string would be read in the server's local time.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** PayPal guarantees funds for 3 days after (re)authorization. */
export const HONOR_DAYS = 3;
/** A hold lives 29 days from the original authorization; day 30 needs a new order. */
export const HOLD_LIFE_DAYS = 29;
/** First day a reauthorize is accepted (spike 20.10: day 0 -> REAUTHORIZATION_TOO_SOON). */
export const REAUTH_FROM_DAY = 4;
/** From this day a donor with money left gets a "renew for another month" link. */
export const RENEWAL_FROM_DAY = 26;
/** Accrued shares are captured once expiry is this close. */
export const CAPTURE_BEFORE_EXPIRY_MS = 2 * DAY_MS;
/** Wait after the n-th refused capture of a hold: 15 min, then doubling. */
export const CAPTURE_RETRY_BASE_MS = 15 * 60_000;

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseTime(iso: string, what = "time"): number {
  const t = ISO_ZONED.test(iso) ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) {
    throw new CoreError("invalid_time", `${what} must be an ISO date-time with a zone, got ${JSON.stringify(iso)}`);
  }
  return t;
}

export function addMs(iso: string, ms: number): string {
  return new Date(parseTime(iso) + ms).toISOString();
}

/** Whole days elapsed since `fromIso`: 0 during the first 24 hours. */
export function dayIndex(fromIso: string, nowIso: string): number {
  return Math.floor((parseTime(nowIso) - parseTime(fromIso)) / DAY_MS);
}
