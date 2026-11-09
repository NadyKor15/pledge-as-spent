import { readFields, respond, str, withService } from "@/server/http";

/**
 * The coordinator's decision on a flagged receipt. Body: { decision: "approve" | "reject", reason, by?, lineNos?, lineNeeds? }.
 * `lineNos` names lines the classifier marked "review" that the coordinator also approves (JSON array or "2,5").
 * `lineNeeds` gives the need a line bought when the reading named none of this drive's: JSON [{ lineNo, needId }]
 * or a form's "1:water,3:water". Picking a need approves the line.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/receipts/[id]/decision">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    const f = await readFields(req);
    const raw = f.lineNos;
    const lineNos = raw === undefined || raw === "" ? undefined : (Array.isArray(raw) ? raw : String(raw).split(",")).map((x) => Number(String(x).trim()));
    const result = await svc.coordinatorDecision(id, str(f.decision) as "approve" | "reject", str(f.reason) ?? "", { lineNos, by: str(f.by), lineNeeds: lineNeedsOf(f.lineNeeds) });
    return respond(f, result);
  });
}

/** Whatever was sent is handed on as it came: the service checks every entry. */
function lineNeedsOf(raw: unknown): { lineNo: number; needId: string }[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (Array.isArray(raw)) return raw.map((p) => ({ lineNo: Number((p as { lineNo?: unknown })?.lineNo), needId: String((p as { needId?: unknown })?.needId ?? "") }));
  return String(raw)
    .split(",")
    .map((pair) => {
      const [no, needId] = pair.split(":");
      return { lineNo: Number(String(no).trim()), needId: String(needId ?? "").trim() };
    });
}
