import type { PayPalErrorInfo } from "./types";

export class PayPalError extends Error implements PayPalErrorInfo {
  readonly httpStatus: number;
  readonly name: string;
  readonly issue?: string;
  readonly debugId?: string;

  constructor(info: PayPalErrorInfo) {
    super(info.message ?? `PayPal HTTP ${info.httpStatus}`);
    this.httpStatus = info.httpStatus;
    this.name = info.name ?? "PayPalError";
    this.issue = info.issue;
    this.debugId = info.debugId;
  }

  /** Builds the error from a PayPal error body (REST v1/v2 shape or OAuth shape). */
  static fromResponse(httpStatus: number, bodyText: string, debugHeader?: string | null): PayPalError {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      // Non-JSON error body (gateway HTML, empty): keep the status only.
    }
    const details = Array.isArray(body.details) ? (body.details as { issue?: string; description?: string }[]) : [];
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return new PayPalError({
      httpStatus,
      name: str(body.name) ?? str(body.error),
      issue: details[0]?.issue,
      message: [str(body.message) ?? str(body.error_description), details[0]?.description].filter(Boolean).join(" — ") || undefined,
      debugId: str(body.debug_id) ?? debugHeader ?? undefined,
    });
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
