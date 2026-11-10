import { readFields, respond, withService } from "@/server/http";

/**
 * The donor renews the hold: a new order for what it has not promised yet, approved again
 * in the PayPal window (`approval: "paypal_window"`: the JS SDK takes `orderId`, then
 * POST /api/pledges/<new id>/approve), or at once on a demo drive with PayPal's sandbox
 * test card (`approval: "sandbox_test_card"`, status "authorized"). A second press while
 * a renewal waits answers that renewal. 404 while RENEW_ENABLED is off; 409 names the rule.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/pledges/[id]/renew">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const out = await svc.renewPledge(id);
    return respond(f, out, out.created ? 201 : 200); // 200: the renewal already under way
  });
}
