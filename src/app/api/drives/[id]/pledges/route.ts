import { readFields, str, withService } from "@/server/http";
import type { Money } from "@/core/types";

/**
 * A donor pledge: { needId, donorName, donorCountry?, amount: { currency, minor } },
 * or a company match: { match: { ratioNum, ratioDen }, donorName, amount }.
 * Returns the PayPal order id for the JS SDK buttons.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/drives/[id]/pledges">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const amount = (f.amount ?? {}) as Partial<Money>;
    const match = f.match as { ratioNum?: unknown; ratioDen?: unknown } | undefined;
    const pledge = await svc.createPledge({
      driveId: id,
      needId: str(f.needId) ?? null,
      match: match ? { ratioNum: Number(match.ratioNum), ratioDen: Number(match.ratioDen) } : null,
      donorName: String(f.donorName ?? ""),
      donorCountry: str(f.donorCountry) ?? null,
      amount: { currency: amount.currency as Money["currency"], minor: Number(amount.minor) },
    });
    return Response.json(pledge, { status: 201 });
  });
}
