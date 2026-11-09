import { lineMoney, lineName, lineViews } from "@/ui/derive";
import { money } from "@/ui/format";
import { ServiceError } from "./errors";
import type { PledgeService } from "./service";

// The receipt bot: a chat is a second way into the same reading path as the web
// form. Each chat gets one demo drive a day. Photos go to submitReceipt and are
// stored only where a web upload is stored; texts are not kept. The bot token is
// part of Telegram's URLs, so errors are reported without them. A receipt held for
// a person is decided here by the chat's owner, the coordinator of their own demo
// drive; the bot never opens or touches any other drive.

/** In a chat a flag is a few plain words; the amounts behind it are on the coordinator's screen. */
const FLAG_WORDS: Record<string, string> = {
  total_mismatch: "its total does not match its lines",
  duplicate: "it looks like a receipt already sent",
  poor_quality: "the photo is hard to read",
  low_confidence: "some lines need a person to confirm them",
  date_unknown: "no purchase date could be read",
  zone_unknown: "no store address could be read",
  tax_unknown: "the tax on some lines cannot be worked out",
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

interface Callback {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number; type?: string } };
}

interface Update {
  update_id?: number;
  message?: Message;
  callback_query?: Callback;
}

type Receipt = Awaited<ReturnType<PledgeService["getDriveView"]>>["receipts"][number];
interface Button {
  text: string;
  callback_data: string;
}

/** Telegram lists a photo in several sizes; only the largest is worth reading. */
const largest = (sizes: TelegramFile[] | undefined) => sizes?.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) >= (a.width ?? 0) * (a.height ?? 0) ? b : a));

const chatKey = (chatId: number) => `telegram:${chatId}`;
const drivePrefix = (svc: PledgeService, chatId: number) => `demo-tg-${svc.hashIp(chatKey(chatId)).slice(0, 10)}-`;

function chatTools(chatId: number, deps: TelegramDeps) {
  const call: typeof fetch = (url, init) => (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
  const method = (name: string, body: Record<string, unknown>) =>
    call(`${API}/bot${deps.token}/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const driveUrl = (driveId: string) => (deps.baseUrl ? `${deps.baseUrl}/drive/${driveId}?as=coordinator` : null);
  return {
    call,
    method,
    driveUrl,
    sandboxNote: (driveId: string, lead: string) => `\n\nSandbox, no real money.${driveUrl(driveId) ? ` ${lead}: ${driveUrl(driveId)}` : ""}`,
    say: (text: string, buttons?: Button[]) =>
      method("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}) }),
    typing: () => method("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined),
  };
}

/** What became of a receipt, in the book's own words, with the coordinator's buttons when a person has to decide. */
async function report(svc: PledgeService, tools: ReturnType<typeof chatTools>, driveId: string, receipt: Receipt) {
  const view = await svc.getDriveView(driveId);
  const paid = view.payouts.find((p) => p.receiptId === receipt.id)?.attempts.at(-1)?.amount ?? null;
  const fates = lineViews(view, receipt);
  const approved = fates.filter((l) => l.shares.length > 0).length;
  const refused = fates.filter((l) => l.state === "rejected");
  const reasons = [...new Set(refused.map((l) => l.reason).filter(Boolean))].join(" ");
  const sample = receipt.reader.startsWith("recognized:") ? "I recognized our sample receipt, so this is its saved, checked reading. A photo of your own is read live.\n\n" : "";
  const head = `${sample}Receipt: ${receipt.lines.length} lines, ${money(receipt.currency, receipt.total) || "total not read"}.`;
  if (receipt.status === "funded") {
    const why = reasons ? `\nRefused: ${reasons}` : "";
    const payout = paid ? `${money(receipt.currency, paid)} goes to the volunteer through PayPal Payouts. ` : "";
    await tools.say(`${head}\n${approved} approved, ${refused.length} refused.${why}\n${payout}Donors are charged only for the approved lines.${tools.sandboxNote(driveId, "Follow it here")}`);
  } else if (receipt.status === "review") {
    const rows = fates.map((l) => `${l.line.lineNo}. ${lineName(l).title} · ${lineMoney(receipt.currency, l.line)}${l.state === "rejected" ? " · not funded" : ""}`);
    // A total that does not add up or a second copy is not a yes-or-no for a chat: approving would accept it as it stands.
    const onlyReject = receipt.flags.some((f) => f.severity === "block" || f.code === "total_mismatch");
    const ask = onlyReject ? `A coordinator will check it on the drive, and no money moves until then.${tools.driveUrl(driveId) ? " In this demo you are the coordinator." : ""}` : "In this demo you are the coordinator: approve or reject it here. No money moves until you do.";
    const reject = { text: "Reject", callback_data: `reject:${receipt.id}` };
    await tools.say(
      `${head}\nThe receipt was read, but ${reviewWhy(receipt.flags.map((f) => f.code))}.\n\n${rows.join("\n")}\n\n${ask}${tools.sandboxNote(driveId, "Open the drive")}`,
      onlyReject ? [reject] : [{ text: "Approve as coordinator", callback_data: `approve:${receipt.id}` }, reject],
    );
  } else {
    await tools.say(`${head}\n${reasons || "No line matches what this drive needs."}\nNo money moves.${tools.sandboxNote(driveId, "Your drive")}`);
  }
}

/** A press on Approve or Reject. Bad clients can send any data here, so the receipt must belong to this chat's own drive. */
async function decide(svc: PledgeService, q: Callback, deps: TelegramDeps) {
  const chat = q.message?.chat;
  const tools = chatTools(chat?.id ?? 0, deps);
  const answer = (text: string) => tools.method("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => undefined);
  const hit = /^(approve|reject):(demo-tg-[0-9a-f]{10}-\d{8})\.r\d+$/.exec(q.data ?? "");
  if (!chat || chat.type !== "private" || !hit || !hit[2].startsWith(drivePrefix(svc, chat.id))) {
    await answer("This button is not for this chat.");
    return;
  }
  const decision = hit[1] as "approve" | "reject";
  const receiptId = (q.data ?? "").slice(decision.length + 1);
  const clear = () => tools.method("editMessageReplyMarkup", { chat_id: chat.id, message_id: q.message!.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  try {
    const { receipt } = await svc.coordinatorDecision(receiptId, decision, "Decided in the Telegram demo", { by: "telegram coordinator" });
    await answer(decision === "approve" ? "Approved." : "Rejected.");
    await clear();
    if (decision === "approve") await report(svc, tools, hit[2], receipt);
    else await tools.say(`Rejected by the coordinator. No money moves.${tools.sandboxNote(hit[2], "Your drive")}`);
  } catch (e) {
    if (e instanceof ServiceError) {
      await answer(e.code === "already_decided" ? "Already decided." : e.message.slice(0, 190));
      if (e.code === "already_decided") await clear();
      return;
    }
    await answer("Something went wrong on our side. No money moved.");
    console.error("telegram decision failed:", e instanceof Error ? e.name : "unknown");
  }
}

export async function handleTelegramUpdate(svc: PledgeService, raw: unknown, deps: TelegramDeps): Promise<void> {
  const update = (raw ?? {}) as Update;
  if (typeof update.update_id !== "number") return;
  const q = update.callback_query;
  const m = update.message;
  if (!q && (!m?.chat || m.chat.type !== "private")) return;
  if (!(await svc.claimDelivery(`telegram:${update.update_id}`, "telegram.update"))) return;
  if (q) return decide(svc, q, deps);

  const chatId = m!.chat.id;
  const tools = chatTools(chatId, deps);
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const driveId = `${drivePrefix(svc, chatId)}${day}`;
  const ip = chatKey(chatId);
  const url = tools.driveUrl(driveId);

  try {
    await tools.typing();
    // A file is judged by its bytes in submitReceipt: Telegram guesses its type from the name.
    const file = m!.document ?? largest(m!.photo);
    if (!file) {
      await svc.createDemoDrive({ driveId, ip, enforceLimit: true });
      await tools.say(`${SANDBOX}\n\nSend a photo of a store receipt and I will read it for the Kitasora drive.${url ? `\nYour drive: ${url}` : ""}`);
      return;
    }
    if ((file.file_size ?? 0) > svc.limits.maxImageBytes) {
      await tools.say("This photo is too large. Send it as a normal Telegram photo, not as a file.");
      return;
    }
    await tools.say("Reading your receipt…");
    await svc.createDemoDrive({ driveId, ip, enforceLimit: true });
    const info = (await (await tools.call(`${API}/bot${deps.token}/getFile?file_id=${encodeURIComponent(file.file_id)}`)).json()) as { result?: { file_path?: string } };
    if (!info.result?.file_path) throw new Error("no file path");
    const bytes = new Uint8Array(await (await tools.call(`${API}/file/bot${deps.token}/${info.result.file_path}`)).arrayBuffer());
    const { receipt } = await svc.submitReceipt({ driveId, bytes, channel: "telegram", ip });
    await report(svc, tools, driveId, receipt);
  } catch (e) {
    const text = e instanceof ServiceError ? e.message : "Something went wrong on our side. No money moved. Please try again.";
    await tools.say(`${text}${url ? `\n\nYour drive: ${url}` : ""}`).catch(() => {});
    if (!(e instanceof ServiceError)) console.error("telegram update failed:", e instanceof Error ? e.name : "unknown");
  }
}
