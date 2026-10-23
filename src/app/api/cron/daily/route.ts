import { bearerMatches, withService } from "@/server/http";

/** Daily job (Vercel cron, once a day): lookups, due captures, hold maintenance, closing old demo drives. */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "not_configured", message: "CRON_SECRET is not set." }, { status: 503 });
  if (!bearerMatches(req, process.env.CRON_SECRET)) return Response.json({ error: "unauthorized", message: "Bearer token required." }, { status: 401 });
  return withService(async (svc) => Response.json(await svc.runDaily()));
}
