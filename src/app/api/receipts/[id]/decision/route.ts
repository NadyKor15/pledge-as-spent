import { readFields, respond, str, withService } from "@/server/http";

/** The coordinator's decision on a flagged receipt. Body: { decision: "approve" | "reject", reason }. */
export async function POST(req: Request, ctx: RouteContext<"/api/receipts/[id]/decision">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const result = await svc.coordinatorDecision(id, str(f.decision) as "approve" | "reject", str(f.reason) ?? "");
    return respond(f, result);
  });
}
