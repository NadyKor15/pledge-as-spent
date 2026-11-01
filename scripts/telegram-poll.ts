// Runs the receipt bot by long polling instead of the webhook: one process, no
// listening port, the same handler as the webhook route. Secrets come from the
// environment. Logs carry neither message text nor the token.
//
//   TELEGRAM_BOT_TOKEN   the bot
//   APP_BASE_URL         origin for drive links; empty on a local run with its own database
//   POLL_LOG             pulse log file (default: .data/telegram-poll.log)
//   POLL_HOURS           stop after this many hours (default 6)
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getService } from "../src/server/runtime";
import { handleTelegramUpdate } from "../src/server/telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
const logFile = process.env.POLL_LOG ?? ".data/telegram-poll.log";
mkdirSync(path.dirname(logFile), { recursive: true });
const pulse = (m: string) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);

const WAIT_S = 25;
const MAX_FAILURES = 5;
const deadline = Date.now() + Number(process.env.POLL_HOURS ?? 6) * 3_600_000;

async function api(method: string, query = ""): Promise<{ ok: boolean; result?: unknown; error_code?: number }> {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}${query}`, { signal: AbortSignal.timeout((WAIT_S + 15) * 1000) });
  return (await r.json()) as { ok: boolean; result?: unknown; error_code?: number };
}

interface Update {
  update_id: number;
  message?: { text?: string; photo?: unknown; document?: { mime_type?: string }; sticker?: unknown };
}

const kind = (u: Update) => (u.message?.photo ? "photo" : u.message?.document ? `document ${u.message.document.mime_type ?? "no-type"}` : u.message?.sticker ? "sticker" : u.message?.text ? "text" : "other");

async function main() {
  const svc = await getService();
  const hook = (await api("getWebhookInfo")) as { result?: { url?: string } };
  if (hook.result?.url) throw new Error("a webhook is set: Telegram refuses polling while it is");
  pulse("start polling, no webhook set");
  let offset = 0;
  let failures = 0;
  while (Date.now() < deadline) {
    try {
      const got = await api("getUpdates", `?timeout=${WAIT_S}&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`);
      if (!got.ok) throw new Error(`getUpdates refused ${got.error_code}`);
      failures = 0;
      const updates = got.result as Update[];
      pulse(`tick updates=${updates.length}`);
      for (const u of updates) {
        offset = u.update_id + 1;
        const t0 = Date.now();
        await handleTelegramUpdate(svc, u, { token: token!, baseUrl: process.env.APP_BASE_URL ?? "" });
        pulse(`handled ${kind(u)} in ${Date.now() - t0} ms`);
      }
    } catch (e) {
      failures += 1;
      pulse(`error ${failures} ${e instanceof Error ? e.name : "unknown"}`);
      if (failures >= MAX_FAILURES) {
        pulse("stop after repeated failures");
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  pulse("stop at deadline");
  process.exit(0);
}

main().catch((e) => {
  pulse(`fatal ${e instanceof Error ? e.message.replaceAll(token, "<token>").slice(0, 160) : "unknown"}`);
  process.exit(3);
});
