// How a refused capture is treated. Issue names come from the error list of
// PayPal Payments v2 (its OpenAPI schema as published on 2026-10-23, `x-errors`).

/** The authorization can never be captured again: stop and release. */
const TERMINAL = new Set([
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "PREVIOUSLY_CAPTURED",
  "PREVIOUSLY_VOIDED",
  "MAX_CAPTURE_COUNT_EXCEEDED",
  "MAX_CAPTURE_AMOUNT_EXCEEDED",
  "AUTH_CAPTURE_CURRENCY_MISMATCH",
  "INSTRUMENT_DECLINED",
  "CARD_EXPIRED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYER_CANNOT_PAY",
  "PAYEE_ACCOUNT_RESTRICTED",
  "TRANSACTION_REFUSED",
]);

/** Worth another try later. Anything not named here is retried too, but only a bounded number of times. */
const RETRYABLE = new Set(["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "RATE_LIMIT_REACHED", "PREVIOUS_REQUEST_IN_PROGRESS", "TIMEOUT"]);

/** Consecutive refused batches on one hold before the engine stops trying. */
export const MAX_CAPTURE_ATTEMPTS = 3;

export interface CaptureFailureClass {
  terminal: boolean;
  /** The PayPal issue (or HTTP status) that decided it; null when nothing was recognised. */
  code: string | null;
}

export function classifyCaptureFailure(reason: string): CaptureFailureClass {
  const tokens = String(reason ?? "").toUpperCase().match(/[A-Z0-9_]+/g) ?? [];
  const terminal = tokens.find((t) => TERMINAL.has(t));
  if (terminal) return { terminal: true, code: terminal };
  const retryable = tokens.find((t) => RETRYABLE.has(t) || /^5\d\d$/.test(t));
  return { terminal: false, code: retryable ?? null };
}
