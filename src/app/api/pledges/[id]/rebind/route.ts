import { readFields, respond, str, withService } from "@/server/http";

/**
 * The donor moves what is left of the hold to another open need: fields `from` (the need the
 * statement showed) and `to`. No PayPal call. 404 while REBIND_ENABLED is off; 409 names the rule.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/pledges/[id]/rebind">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    return respond(f, await svc.rebindPledge({ pledgeId: id, fromNeedId: str(f.from) ?? "", toNeedId: str(f.to) ?? "" }));
  });
}
