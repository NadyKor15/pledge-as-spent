import { getAgentService } from "@/server/agent";
import { clientIp, errorResponse, readFields } from "@/server/http";

/** A question to the live agent: counted per address and for everyone before any model call. 429 with a sentence when used up. */
export async function POST(req: Request) {
  try {
    const agent = await getAgentService();
    return Response.json(await agent.question(clientIp(req), await readFields(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
