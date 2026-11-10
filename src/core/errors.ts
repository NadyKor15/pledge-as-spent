// Contract violations raise CoreError instead of producing a half-valid ledger:
// the caller applies an event before persisting it, so a throw keeps the journal clean.

export type CoreErrorCode =
  | "invalid_amount"
  | "invalid_currency"
  | "invalid_rate"
  | "invalid_time"
  | "invalid_split"
  | "invalid_event"
  | "invalid_line"
  | "invalid_state"
  | "unknown_drive"
  | "unknown_need"
  | "unknown_pledge"
  | "unknown_receipt"
  | "rebind_refused"
  | "renewal_refused"
  | "invariant_violation";

const CORE_ERROR: unique symbol = Symbol.for("pledge-as-spent.CoreError");

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly [CORE_ERROR] = true;

  constructor(code: CoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CoreError";
    this.code = code;
  }

  /** True for a CoreError made by another copy of this module too (see ServiceError in src/server/errors.ts). */
  static [Symbol.hasInstance](v: unknown): boolean {
    return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[CORE_ERROR] === true;
  }
}
