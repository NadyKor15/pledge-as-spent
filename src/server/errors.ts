import { CoreError } from "../core/errors";

/** An error with an HTTP status and a plain sentence for the caller. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const CORE_STATUS: Partial<Record<CoreError["code"], number>> = {
  unknown_drive: 404,
  unknown_need: 400,
  unknown_pledge: 404,
  unknown_receipt: 404,
  invalid_state: 409,
  invalid_event: 409,
  invariant_violation: 500,
};

/** CoreError -> ServiceError; anything else is returned unchanged. */
export function asServiceError(e: unknown): unknown {
  if (e instanceof CoreError) return new ServiceError(CORE_STATUS[e.code] ?? 400, e.code, e.message);
  return e;
}
