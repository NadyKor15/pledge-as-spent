import { readFields, respond, str, withService } from "@/server/http";

/**
 * The coordinator's decision on a flagged receipt. Body: { decision: "approve" | "reject", reason, by?, lineNos? }.
 * `lineNos` names lines the classifier marked "review" that the coordinator also approves (JSON array or "2,5").
 */
export async function POST(req: Request, ctx: RouteContext<"/api/receipts/[id]/decision">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const raw = f.lineNos;
    const lineNos = raw === undefined || raw === "" ? undefined : (Array.isArray(raw) ? raw : String(raw).split(",")).map((x) => Number(String(x).trim()));
    const result = await svc.coordinatorDecision(id, str(f.decision) as "approve" | "reject", str(f.reason) ?? "", { lineNos, by: str(f.by) });
    return respond(f, result);
  });
}
