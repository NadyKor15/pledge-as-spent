import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../../src/core/errors";
import { ServiceError } from "../../src/server/errors";
import { errorResponse } from "../../src/server/http";

// The end-to-end server builds the service from the source while Next.js runs the routes from its bundle, so an
// error can come from another copy of its module. "No drive x" must still be a 404, not "Something went wrong".

async function freshCopies() {
  vi.resetModules();
  const server = await import("../../src/server/errors");
  const core = await import("../../src/core/errors");
  return { OtherServiceError: server.ServiceError, OtherCoreError: core.CoreError };
}

describe("errors from another copy of their module", () => {
  it("are the same kind of error", async () => {
    const { OtherServiceError, OtherCoreError } = await freshCopies();
    expect(OtherServiceError).not.toBe(ServiceError);
    expect(new OtherServiceError(404, "unknown_drive", "No drive x.")).toBeInstanceOf(ServiceError);
    expect(new OtherCoreError("unknown_drive", "x")).toBeInstanceOf(CoreError);
    expect(new Error("No drive x.")).not.toBeInstanceOf(ServiceError);
    expect({ status: 404, code: "unknown_drive" }).not.toBeInstanceOf(ServiceError);
    expect(new OtherCoreError("unknown_drive", "x")).not.toBeInstanceOf(ServiceError);
  });

  it("answer with their own status and words", async () => {
    const { OtherServiceError, OtherCoreError } = await freshCopies();
    const a = errorResponse(new OtherServiceError(404, "unknown_drive", "No drive demo-0000000000."));
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ error: "unknown_drive", message: "No drive demo-0000000000." });
    expect(errorResponse(new OtherCoreError("unknown_pledge", "p")).status).toBe(404);
    expect(errorResponse(new Error("boom")).status).toBe(500);
  });
});
