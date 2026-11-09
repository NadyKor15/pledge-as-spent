import { isDemoScenarioId } from "@/server/demo";
import { ServiceError } from "@/server/errors";
import { clientIp, readFields, respond, str, withService } from "@/server/http";

/**
 * A fresh demo drive with its donor holds and the company match (sandbox test card). At most 5 an hour per IP.
 * Field `scenario`: kitasora (default; earthquake relief in JPY) or florida (hurricane relief in USD).
 */
export async function POST(req: Request) {
  return withService(async (svc) => {
    const fields = await readFields(req);
    const scenario = str(fields.scenario) ?? "kitasora";
    if (!isDemoScenarioId(scenario)) throw new ServiceError(400, "unknown_scenario", `No demo scenario "${scenario}"; the scenarios are kitasora and florida.`);
    const view = await svc.createDemoDrive({ ip: clientIp(req), scenario });
    if (fields.back !== undefined) return respond({ back: `/debug/drive/${view.drive.id}` }, view);
    return Response.json(view, { status: 201 });
  });
}
