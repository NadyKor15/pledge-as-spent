import { CoreError } from "../core/errors";

const SERVICE_ERROR: unique symbol = Symbol.for("pledge-as-spent.ServiceError");

/** An error with an HTTP status and a plain sentence for the caller. */
export class ServiceError extends Error {
  readonly [SERVICE_ERROR] = true;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  /**
   * True for a ServiceError made by another copy of this module too. The end-to-end server builds the service from
   * the source while Next.js runs the routes from its bundle: two classes, and "No drive x" came out as a 500.
   */
  static [Symbol.hasInstance](v: unknown): boolean {
    return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[SERVICE_ERROR] === true;
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
