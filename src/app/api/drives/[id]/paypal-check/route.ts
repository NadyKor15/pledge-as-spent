import { clientIp, errorResponse } from "@/server/http";
import { getPayPalCheck } from "@/server/paypal-check";

/**
 * "Ask PayPal yourself": each hold, capture and payout of the drive as PayPal's sandbox answers it now (GET only,
 * the server's keys), next to what the book says. One answer per drive is kept for a minute; fresh checks are
 * limited per network.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/drives/[id]/paypal-check">) {
  const { id } = await ctx.params;
  try {
    const check = await getPayPalCheck();
    const result = await check.run(id, clientIp(req));
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
