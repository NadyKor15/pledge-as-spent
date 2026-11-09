import { errorResponse } from "@/server/http";
import { FORGERIES, tryForgery } from "@/server/cheat";

/**
 * "Try to cheat the receipt". Without `?forgery=`: the five forged receipts. With it: that receipt sent to a fresh
 * copy of the demo drive, checked line by line. Nothing is written and PayPal is not called, so there is no limit.
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("forgery");
  try {
    if (!id) return Response.json({ forgeries: FORGERIES }, { headers: { "cache-control": "no-store" } });
    return Response.json(tryForgery(id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
