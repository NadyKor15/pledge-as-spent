import { readFields, respond, withService } from "@/server/http";

/** The donor withdraws: nothing new is funded; what was already bought is captured, the rest is voided. */
export async function POST(req: Request, ctx: RouteContext<"/api/pledges/[id]/revoke">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    return respond(f, await svc.revokePledge(id));
  });
}
