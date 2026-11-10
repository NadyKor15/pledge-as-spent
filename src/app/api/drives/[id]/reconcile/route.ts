import { withService } from "@/server/http";
import { latestReconciliation } from "@/server/reconcile";

/**
 * The drive's last daily check with PayPal, as the server kept it, or null when it has not been checked yet. Read
 * from the database only: this route never asks PayPal.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/drives/[id]/reconcile">) {
  const { id } = await ctx.params;
  return withService(async (svc) => Response.json({ driveId: id, last: await latestReconciliation(svc.db, id) }, { headers: { "cache-control": "no-store" } }));
}
