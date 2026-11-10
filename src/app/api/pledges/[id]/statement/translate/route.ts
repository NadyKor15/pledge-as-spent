import { clientIp, withService } from "@/server/http";
import { getTranslator } from "@/server/runtime";

/** At most this many translation requests per address per hour; a statement asks once when it opens. */
const PER_HOUR = 30;
const seen = new Map<string, number[]>();

function allowed(ipHash: string, now: number): boolean {
  const hour = now - 3_600_000;
  const recent = (seen.get(ipHash) ?? []).filter((t) => t > hour);
  if (recent.length >= PER_HOUR) return false;
  recent.push(now);
  seen.set(ipHash, recent);
  if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((t) => t > hour)) seen.delete(k);
  return true;
}

/**
 * The donor's statement lines in the donor's language: recorded or kept translations first, then one Meta call for the
 * rest within the reading's ceiling; English, said so, whenever that is not possible.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/pledges/[id]/statement/translate">) {
  const { id } = await ctx.params;
  return withService(async (svc) => {
    if (!allowed(svc.hashIp(clientIp(req)), Date.now())) return Response.json({ error: "rate_limited", message: "Too many translation requests from this address; try again in an hour." }, { status: 429 });
    const { drive, statement } = await svc.getStatement(id);
    const view = await svc.getDriveView(drive.id);
    const translator = await getTranslator();
    return Response.json(await translator.forStatement(view, id, statement.rows));
  });
}
