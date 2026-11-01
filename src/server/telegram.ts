import { lineViews } from "@/ui/derive";
import { money } from "@/ui/format";
import { ServiceError } from "./errors";
import type { PledgeService } from "./service";

// The receipt bot: a chat is a second way into the same reading path as the web
// form. Each chat gets one demo drive a day. Photos go to submitReceipt and are
// stored only where a web upload is stored; texts are not kept. The bot token is
// part of Telegram's URLs, so errors are reported without them.

const API = "https://api.telegram.org";
const CALL_MS = 30_000;
const SANDBOX = "This is the Pledge-as-Spent demo in the PayPal sandbox: a fictional drive, no real money moves.";

export interface TelegramDeps {
  token: string;
  /** Public origin of the site. Empty on a local run, whose drives have no public page. */
  baseUrl: string;
  fetch?: typeof fetch;
}

interface TelegramFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
}

interface Message {
  chat: { id: number; type?: string };
  text?: string;
  photo?: TelegramFile[];
  document?: TelegramFile;
}

interface Update {
  update_id?: number;
  message?: Message;
}

export async function handleTelegramUpdate(svc: PledgeService, raw: unknown, deps: TelegramDeps): Promise<void> {
  const update = (raw ?? {}) as Update;
  const m = update.message;
  if (typeof update.update_id !== "number" || !m?.chat || m.chat.type !== "private") return;
  if (!(await svc.claimDelivery(`telegram:${update.update_id}`, "telegram.update"))) return;

  const call: typeof fetch = (url, init) => (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
  const say = async (text: string) => {
    await call(`${API}/bot${deps.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: m.chat.id, text, disable_web_page_preview: true }),
    });
  };
  const chatKey = `telegram:${m.chat.id}`;
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const driveId = `demo-tg-${svc.hashIp(chatKey).slice(0, 10)}-${day}`;
  const link = deps.baseUrl ? `${deps.baseUrl}/drive/${driveId}?as=coordinator` : "(local check, this drive has no public page)";

  const typing = () =>
    call(`${API}/bot${deps.token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: m.chat.id, action: "typing" }),
    }).catch(() => undefined);

  try {
    await typing();
    const file = m.document ?? m.photo?.at(-1);
    if (!file) {
      await svc.createDemoDrive({ driveId, ip: chatKey, enforceLimit: true });
      await say(`${SANDBOX}\n\nSend a photo of a store receipt and I will read it for the Kitasora drive.\nYour drive: ${link}`);
      return;
    }
    if (m.document && !m.document.mime_type?.startsWith("image/")) {
      await say("Please send a photo of a receipt. Other files are not read.");
      return;
    }
    if ((file.file_size ?? 0) > svc.limits.maxImageBytes) {
      await say("This photo is too large. Send it as a normal Telegram photo, not as a file.");
      return;
    }
    await say("Reading your receipt…");
    await svc.createDemoDrive({ driveId, ip: chatKey, enforceLimit: true });
    const info = (await (await call(`${API}/bot${deps.token}/getFile?file_id=${encodeURIComponent(file.file_id)}`)).json()) as { result?: { file_path?: string } };
    if (!info.result?.file_path) throw new Error("no file path");
    const bytes = new Uint8Array(await (await call(`${API}/file/bot${deps.token}/${info.result.file_path}`)).arrayBuffer());

    const { receipt } = await svc.submitReceipt({ driveId, bytes, channel: "telegram", ip: chatKey });
    const view = await svc.getDriveView(driveId);
    const paid = view.payouts.find((p) => p.receiptId === receipt.id)?.attempts.at(-1)?.amount ?? null;
    // The book's own account of each line, the same one the screens show.
    const fates = lineViews(view, receipt);
    const approved = fates.filter((l) => l.shares.length > 0).length;
    const refused = fates.filter((l) => l.state === "rejected");
    const reasons = [...new Set(refused.map((l) => l.reason).filter(Boolean))].join(" ");
    const head = `Receipt: ${receipt.lines.length} lines, ${money(receipt.currency, receipt.total) || "total not read"}.`;
    if (receipt.status === "funded") {
      const why = reasons ? `\nRefused: ${reasons}` : "";
      await say(`${head}\n${approved} approved, ${refused.length} refused.${why}\n${paid ? `${money(receipt.currency, paid)} goes to the volunteer through PayPal Payouts. ` : ""}Donors are charged only for the approved lines.\n\nSandbox, no real money. Follow it here: ${link}`);
    } else if (receipt.status === "review") {
      await say(`${head}\nA coordinator has to decide: ${receipt.flags.map((f) => f.messageEn).join(" ")}\nNo money moves until then. In this demo you are the coordinator: open the drive and decide.\n\nSandbox, no real money: ${link}`);
    } else {
      await say(`${head}\n${reasons || "No line matches what this drive needs."}\nNo money moves.\n\nSandbox, no real money: ${link}`);
    }
  } catch (e) {
    const text = e instanceof ServiceError ? e.message : "Something went wrong on our side. No money moved. Please try again.";
    await say(`${text}\n\nYour drive: ${link}`).catch(() => {});
    if (!(e instanceof ServiceError)) console.error("telegram update failed:", e instanceof Error ? e.name : "unknown");
  }
}
