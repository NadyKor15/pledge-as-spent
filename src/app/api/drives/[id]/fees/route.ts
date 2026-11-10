import { withService } from "@/server/http";
import { reportedFees } from "@/server/reported-fee";

/** What PayPal reported as its fee on each donor's captures (paypal_fee of each capture), from the book. Read only. */
export async function GET(_req: Request, ctx: RouteContext<"/api/drives/[id]/fees">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const view = await svc.getDriveView(id);
    const donors = view.holds.filter((h) => h.kind === "donor").map((h) => ({ pledgeId: h.pledgeId, currency: h.currency }));
    return Response.json({ fees: await reportedFees(svc.db, id, donors) });
  });
}
