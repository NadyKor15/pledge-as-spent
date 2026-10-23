import { withService } from "@/server/http";

/** The drive as the book has it: needs, holds with balances, ledger rows, receipts, PayPal journal. */
export async function GET(_req: Request, ctx: RouteContext<"/api/drives/[id]">) {
  const { id } = await ctx.params;
  return withService(async (svc) => Response.json(await svc.getDriveView(id)));
}
