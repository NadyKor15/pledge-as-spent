import { ServiceError } from "@/server/errors";
import { withService } from "@/server/http";
import { countLine } from "@/ui/landing-count";
import { deriveLedger } from "@/ui/ledger/derive";
import { SHOWCASE_DRIVE_ID } from "@/ui/showcase";

/**
 * The landing page's line about the finished drive: the drive's own book, added up by the Ledger's derive. A
 * deployment without that drive answers 200 with no line; any other failure is an error, as everywhere else.
 */
/** A closed drive's book no longer changes: its line is kept a minute per service, so landing visits do not replay it. */
const KEEP_MS = 60_000;
const kept = new WeakMap<object, { at: number; line: string }>();

export async function GET() {
  return withService(async (svc) => {
    const hit = kept.get(svc);
    if (hit && Date.now() - hit.at < KEEP_MS) return Response.json({ driveId: SHOWCASE_DRIVE_ID, line: hit.line }, { headers: { "cache-control": "no-store" } });
    try {
      const view = await svc.getDriveView(SHOWCASE_DRIVE_ID);
      // Only a line is kept: no line means an open drive or none yet, and either can change any minute.
      const line = countLine(deriveLedger(view, "en"));
      if (line) kept.set(svc, { at: Date.now(), line });
      return Response.json({ driveId: SHOWCASE_DRIVE_ID, line }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof ServiceError && e.code === "unknown_drive") return Response.json({ driveId: SHOWCASE_DRIVE_ID, line: null }, { headers: { "cache-control": "no-store" } });
      throw e;
    }
  });
}
