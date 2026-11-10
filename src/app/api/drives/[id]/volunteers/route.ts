import { bearerMatches, readFields, respond, str, withService } from "@/server/http";
import { limitField } from "@/server/volunteer-fields";

/**
 * The coordinator invites a volunteer: { name, payoutEmail, limitMinor? } (limit in the drive's
 * currency, minor units; absent or "none": no limit). Answers { volunteerId, token, uploadPath }
 * once: only the token's hash is kept. On a real drive only the coordinator may invite
 * (`Authorization: Bearer <COORDINATOR_SECRET>`). 404 while VOLUNTEER_INVITES is off.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/volunteers">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const limitMinor = limitField(f.limitMinor, { absentMeansNone: true });
    const coordinator = bearerMatches(req, process.env.COORDINATOR_SECRET);
    return respond(f, await svc.inviteVolunteer(id, { name: str(f.name) ?? "", payoutEmail: str(f.payoutEmail) ?? "", limitMinor }, { coordinator }), 201);
  });
}
