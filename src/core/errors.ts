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
  | "invariant_violation";

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CoreError";
    this.code = code;
  }
}
