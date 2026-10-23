import { withService } from "@/server/http";

/** "Your pledge bought this": the donor's lines, in their currency, with the match they unlocked. */
export async function GET(_req: Request, ctx: RouteContext<"/api/pledges/[id]/statement">) {
  const { id } = await ctx.params;
  return withService(async (svc) => Response.json(await svc.getStatement(id)));
}
