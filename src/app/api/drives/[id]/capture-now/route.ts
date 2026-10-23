import { readFields, respond, withService } from "@/server/http";

/** The coordinator's "capture now": every accrued share is captured, one batch per hold. */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/capture-now">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    return respond(f, { commands: await svc.captureNow(id) });
  });
}
