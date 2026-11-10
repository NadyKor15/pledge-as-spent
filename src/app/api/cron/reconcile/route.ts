import { bearerMatches, withService } from "@/server/http";
import { getPayPalCheck } from "@/server/paypal-check";
import { runReconciliation } from "@/server/reconcile";
import { SHOWCASE_DRIVE_ID } from "@/ui/showcase";

/** Vercel Hobby stops a function at 300 s; the run starts no new drive after 240 s. */
export const maxDuration = 300;

/**
 * Daily check with PayPal (Vercel cron, once a day): the showcase drive and every open drive, asked about with the
 * code of "Ask PayPal yourself" (GET only), one row per drive kept for the page. Not a network's press: the hourly
 * limit of "Ask PayPal yourself" is not spent.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "not_configured", message: "CRON_SECRET is not set." }, { status: 503 });
  if (!bearerMatches(req, process.env.CRON_SECRET)) return Response.json({ error: "unauthorized", message: "Bearer token required." }, { status: 401 });
  return withService(async (svc) => {
    const check = await getPayPalCheck();
    return Response.json(await runReconciliation({ db: svc.db, check, showcaseId: SHOWCASE_DRIVE_ID, log: (m, x) => console.error(`[pledge-as-spent] ${m}`, x ?? "") }));
  });
}
