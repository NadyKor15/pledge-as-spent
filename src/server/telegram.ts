import { lineViews } from "@/ui/derive";
import { money } from "@/ui/format";
import { ServiceError } from "./errors";
import type { PledgeService } from "./service";

// The receipt bot: a chat is a second way into the same reading path as the web
// form. Each chat gets one demo drive a day. Photos go to submitReceipt and are
// stored only where a web upload is stored; texts are not kept. The bot token is
// part of Telegram's URLs, so errors are reported without them.

/** In a chat a flag is a few plain words; the amounts behind it are on the coordinator's screen. */
const FLAG_WORDS: Record<string, string> = {
  total_mismatch: "its total does not match its lines",
  duplicate: "it looks like a receipt already sent",
  poor_quality: "the photo is hard to read",
  low_confidence: "some lines need a person to confirm them",
  date_unknown: "no purchase date could be read",
  zone_unknown: "no store address could be read",
};
const reviewWhy = (codes: string[]) => [...new Set(codes.map((c) => FLAG_WORDS[c]).filter(Boolean))].join(" and ") || "a person should check it";

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
  width?: number;
  height?: number;
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

/** Telegram lists a photo in several sizes; only the largest is worth reading. */
const largest = (sizes: TelegramFile[] | undefined) => sizes?.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) >= (a.width ?? 0) * (a.height ?? 0) ? b : a));

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
  const driveUrl = deps.baseUrl ? `${deps.baseUrl}/drive/${driveId}?as=coordinator` : null;
  const sandboxNote = (lead: string) => `\n\nSandbox, no real money.${driveUrl ? ` ${lead}: ${driveUrl}` : ""}`;

  const typing = () =>
    call(`${API}/bot${deps.token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: m.chat.id, action: "typing" }),
    }).catch(() => undefined);

  try {
    await typing();
    // A file is judged by its bytes in submitReceipt: Telegram guesses its type from the name.
    const file = m.document ?? largest(m.photo);
    if (!file) {
      await svc.createDemoDrive({ driveId, ip: chatKey, enforceLimit: true });
      await say(`${SANDBOX}\n\nSend a photo of a store receipt and I will read it for the Kitasora drive.${driveUrl ? `\nYour drive: ${driveUrl}` : ""}`);
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
      await say(`${head}\n${approved} approved, ${refused.length} refused.${why}\n${paid ? `${money(receipt.currency, paid)} goes to the volunteer through PayPal Payouts. ` : ""}Donors are charged only for the approved lines.${sandboxNote("Follow it here")}`);
    } else if (receipt.status === "review") {
      await say(`${head}\nThe receipt was read, but ${reviewWhy(receipt.flags.map((f) => f.code))}. A coordinator will check it, and no money moves until then.${driveUrl ? " In this demo you are the coordinator." : ""}${sandboxNote("Open the drive")}`);
    } else {
      await say(`${head}\n${reasons || "No line matches what this drive needs."}\nNo money moves.${sandboxNote("Your drive")}`);
    }
  } catch (e) {
    const text = e instanceof ServiceError ? e.message : "Something went wrong on our side. No money moved. Please try again.";
    await say(`${text}${driveUrl ? `\n\nYour drive: ${driveUrl}` : ""}`).catch(() => {});
    if (!(e instanceof ServiceError)) console.error("telegram update failed:", e instanceof Error ? e.name : "unknown");
  }
}
