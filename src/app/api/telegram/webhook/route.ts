import { timingSafeEqual } from "node:crypto";
import { withService } from "@/server/http";
import { handleTelegramUpdate } from "@/server/telegram";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Telegram updates. Telegram sends back the secret set with setWebhook; anything else changes nothing. */
export async function POST(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return Response.json({ error: "not_configured", message: "The receipt bot is not set up here." }, { status: 404 });
  if (!same(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return Response.json({ error: "unauthorized", message: "Bad secret." }, { status: 401 });
  const update: unknown = await req.json().catch(() => null);
  return withService(async (svc) => {
    await handleTelegramUpdate(svc, update, { token, baseUrl: process.env.APP_BASE_URL ?? new URL(req.url).origin });
    return Response.json({ ok: true });
  });
}
