import { ServiceError } from "./errors";

/**
 * A volunteer's limit as a form or JSON sends it, in minor units of the drive's currency.
 * "none" (or an empty field) means no limit; on an invitation an absent field means none too.
 * Anything else must be a whole number above 0: a mistyped "$500" or a NaN turned into null
 * by JSON is a 400, never silently "no limit".
 */
export function limitField(raw: unknown, opts: { absentMeansNone: boolean }): number | null {
  if (raw === undefined) {
    if (opts.absentMeansNone) return null;
    throw new ServiceError(400, "invalid_limit", "limitMinor is required: a whole number of minor units, or \"none\".");
  }
  if (raw === "none" || raw === "") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ServiceError(400, "invalid_limit", "limitMinor must be a whole number of minor units above 0, or \"none\" for no limit.");
  return n;
}
