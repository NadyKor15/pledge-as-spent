import { ServiceError } from "@/server/errors";
import { withService } from "@/server/http";
import { countLine } from "@/ui/landing-count";
import { deriveLedger } from "@/ui/ledger/derive";
import { SHOWCASE_DRIVE_ID } from "@/ui/showcase";

/**
 * The landing page's line about the finished drive: the drive's own book, added up by the Ledger's derive. A
 * deployment without that drive answers 200 with no line; any other failure is an error, as everywhere else.
 */
export async function GET() {
  return withService(async (svc) => {
    try {
      const view = await svc.getDriveView(SHOWCASE_DRIVE_ID);
      return Response.json({ driveId: SHOWCASE_DRIVE_ID, line: countLine(deriveLedger(view, "en")) }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof ServiceError && e.code === "unknown_drive") return Response.json({ driveId: SHOWCASE_DRIVE_ID, line: null }, { headers: { "cache-control": "no-store" } });
      throw e;
    }
  });
}
