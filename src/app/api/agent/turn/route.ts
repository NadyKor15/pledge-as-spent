import { getAgentService } from "@/server/agent";
import { clientIp, errorResponse, readFields } from "@/server/http";

/** One model turn of a question (Converse, no streaming), only from the address that asked it. The browser runs AG Studio's agent loop around it. */
export async function POST(req: Request) {
  try {
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > 400_000) return Response.json({ error: "too_large", message: "The turn is too large." }, { status: 413 });
    const agent = await getAgentService();
    return Response.json(await agent.turn(await readFields(req), clientIp(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
