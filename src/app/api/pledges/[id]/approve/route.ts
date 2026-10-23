import { readFields, str, withService } from "@/server/http";

/** After the donor approved in the PayPal window (JS SDK onApprove): authorize the order. Body: { orderId }. */
export async function POST(req: Request, ctx: RouteContext<"/api/pledges/[id]/approve">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    return Response.json(await svc.approvePledge(id, str(f.orderId) ?? null));
  });
}
