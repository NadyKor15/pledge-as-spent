import { withService } from "@/server/http";

/** PayPal webhooks. The signature is checked with PayPal; unverified or unknown events change nothing. */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  return withService(async (svc) => {
    const { status, body } = await svc.handleWebhook(headers, rawBody);
    return Response.json(body, { status });
  });
}
