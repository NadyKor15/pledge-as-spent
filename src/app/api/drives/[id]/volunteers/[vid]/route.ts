import { bearerMatches, readFields, respond, str, withService } from "@/server/http";
import { ServiceError } from "@/server/errors";
import { limitField } from "@/server/volunteer-fields";

/**
 * The coordinator changes a volunteer: { action: "remove" } stops their link and their payouts;
 * { action: "limit", limitMinor } sets their limit ("none": no limit) and pays receipts that waited
 * for it. On a real drive only the coordinator may (`Authorization: Bearer <COORDINATOR_SECRET>`);
 * the demo's own volunteer cannot be changed.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/volunteers/[vid]">) {
  const { id, vid } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const action = str(f.action);
    const coordinator = bearerMatches(req, process.env.COORDINATOR_SECRET);
    if (action === "remove") return respond(f, await svc.removeVolunteer(id, vid, { coordinator }));
    if (action === "limit") return respond(f, await svc.setVolunteerLimit(id, vid, limitField(f.limitMinor, { absentMeansNone: false }), { coordinator }));
    throw new ServiceError(400, "invalid_action", "action must be remove or limit.");
  });
}
