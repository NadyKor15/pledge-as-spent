import { readFields, respond, str, withService } from "@/server/http";
import { ServiceError } from "@/server/errors";

/**
 * The coordinator changes a volunteer: { action: "remove" } stops their link and their payouts;
 * { action: "limit", limitMinor } sets their limit (null: none) and pays receipts that waited for it.
 * 404 while VOLUNTEER_INVITES is off.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/volunteers/[vid]">) {
  const { id, vid } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const action = str(f.action);
    if (action === "remove") return respond(f, await svc.removeVolunteer(id, vid));
    if (action === "limit") {
      const limit = f.limitMinor === undefined || f.limitMinor === null || f.limitMinor === "" ? null : Number(f.limitMinor);
      return respond(f, await svc.setVolunteerLimit(id, vid, limit));
    }
    throw new ServiceError(400, "invalid_action", "action must be remove or limit.");
  });
}
