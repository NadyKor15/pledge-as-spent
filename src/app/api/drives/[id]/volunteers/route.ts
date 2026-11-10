import { readFields, respond, str, withService } from "@/server/http";

/**
 * The coordinator invites a volunteer: { name, payoutEmail, limitMinor? } (limit in the drive's
 * currency, minor units; absent: none). Answers { volunteerId, token, uploadPath } once: only the
 * token's hash is kept. 404 while VOLUNTEER_INVITES is off; 400 names what is wrong.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/volunteers">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const limit = f.limitMinor === undefined || f.limitMinor === null || f.limitMinor === "" ? null : Number(f.limitMinor);
    return respond(f, await svc.inviteVolunteer(id, { name: str(f.name) ?? "", payoutEmail: str(f.payoutEmail) ?? "", limitMinor: limit }), 201);
  });
}
