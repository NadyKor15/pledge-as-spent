import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { events, receipts } from "../../src/db/schema";
import { POST as webhookPOST } from "../../src/app/api/telegram/webhook/route";
import { READ_A_SYSTEM, READ_B_SYSTEM } from "../../src/receipts/meta-reader";
import { setServiceForTests } from "../../src/server/runtime";
import { handleTelegramUpdate } from "../../src/server/telegram";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";
import { noisePng, syntheticReceipt } from "./support/synthetic";

/**
 * Meta's model for a picture that is not a receipt: both readings answer without a receipt. Each request is answered
 * by the prompt it carries, never by the order the calls arrive in (the two readings run at the same time).
 */
function notAReceipt() {
  const asked: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const { instructions } = JSON.parse(String(init.body)) as { instructions: string };
    asked.push(instructions === READ_A_SYSTEM ? "read A" : instructions === READ_B_SYSTEM ? "read B" : "other");
    const text = "I see no receipt in this picture.";
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

async function bot(files: Record<string, Uint8Array> = {}) {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const meta = notAReceipt();
  const h = await harness({ fetch: pp.fetch, recordings: rec, pipeline: "meta", metaReading: { apiKey: "k", capUsd: 3, fetch: meta.fetch } });
  const said: string[] = [];
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const tg = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.body) calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (String(url).includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body));
      said.push(body.text);
      bodies.push(body);
      return Response.json({ ok: true });
    }
    if (init?.body) return Response.json({ ok: true });
    const m = /getFile\?file_id=(.+)$/.exec(String(url));
    if (m) return Response.json({ ok: true, result: { file_path: `photos/${m[1]}` } });
    const name = String(url).split("/").pop()!;
    return new Response(Buffer.from(files[name]));
  }) as unknown as typeof fetch;
  const deps = { token: "TEST-TOKEN", baseUrl: "https://demo.example", fetch: tg };
  const send = (update_id: number, message: Record<string, unknown>) => handleTelegramUpdate(h.svc, { update_id, message: { chat: { id: 77, type: "private" }, ...message } }, deps);
  const money = async () => (await h.db.db.select().from(events)).filter((e) => e.type === "LineFunded").length;
  return { h, pp, rec, meta, files, said, urls, bodies, calls, deps, send, money };
}

describe("the receipt bot", () => {
  it("/start says it is the sandbox and gives the link to the chat's drive", async () => {
    const b = await bot();
    await b.send(1, { text: "/start" });
    expect(b.said[0]).toContain("PayPal sandbox");
    expect(b.said[0]).toMatch(/no real money/);
    expect(b.said[0]).toMatch(/https:\/\/demo\.example\/drive\/demo-tg-[0-9a-f]{10}-\d{8}\?as=coordinator/);
    expect(b.urls[0]).toContain("/sendChatAction");
  });

  it("a receipt photo goes through the same reading path as the web form", async () => {
    const b = await bot({ hero: heroBytes() });
    await b.send(2, { photo: [{ file_id: "small" }, { file_id: "hero" }] });
    const reply = b.said.at(-1)!;
    expect(reply).toContain("9 approved, 2 refused");
    expect(reply).toContain("¥10,448 goes to the volunteer");
    expect(reply).toContain("no real money");
    const [row] = await b.h.db.db.select().from(receipts);
    expect(row.channel).toBe("telegram");
    expect(await b.money()).toBeGreaterThan(0);
  });

  it("the same update delivered twice is handled once", async () => {
    const b = await bot({ hero: heroBytes() });
    await b.send(3, { photo: [{ file_id: "hero" }] });
    await b.send(3, { photo: [{ file_id: "hero" }] });
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(1);
  });

  it("a picture that is not a receipt gets a plain answer and moves no money", async () => {
    const b = await bot({ cat: noisePng(501) });
    await b.send(4, { photo: [{ file_id: "cat" }] });
    expect(b.said.at(-1)).toContain("could not be read");
    expect(b.meta.asked).toContain("read A");
    expect(b.meta.asked).not.toContain("other"); // nothing unread is classified
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(0);
    expect(await b.money()).toBe(0);
  });

  it("a file is judged by its bytes, whatever type Telegram gives it", async () => {
    const b = await bot({ hero: heroBytes(), pdf: new TextEncoder().encode("%PDF-1.7 not an image") });
    await b.send(5, { document: { file_id: "pdf", mime_type: "application/pdf" } });
    expect(b.said.at(-1)).not.toContain("approved");
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(0);
    await b.send(16, { document: { file_id: "hero", mime_type: "video/apng" } });
    expect(b.said.at(-1)).toContain("9 approved, 2 refused");
    await b.send(17, { document: { file_id: "pdf", mime_type: "application/octet-stream" } });
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(1);
  });

  it("reads the largest size of a photo, in whatever order Telegram lists them", async () => {
    const b = await bot({ hero: heroBytes() });
    await b.send(18, { photo: [{ file_id: "hero", width: 624, height: 1280 }, { file_id: "thumb", width: 44, height: 90 }] });
    expect(b.urls.some((u) => u.includes("file_id=hero"))).toBe(true);
    expect(b.urls.some((u) => u.includes("file_id=thumb"))).toBe(false);
  });

  it("an oversized photo is refused before it is downloaded", async () => {
    const b = await bot();
    await b.send(6, { photo: [{ file_id: "big", file_size: 9_000_000 }] });
    expect(b.said.at(-1)).toContain("too large");
    expect(b.urls.some((u) => u.includes("/file/bot"))).toBe(false);
  });

  it("a duplicate of a receipt the chat already sent moves no money twice", async () => {
    const b = await bot({ hero: heroBytes() });
    await b.send(7, { photo: [{ file_id: "hero" }] });
    const funded = await b.money();
    await b.send(8, { photo: [{ file_id: "hero" }] });
    expect(b.said.at(-1)).toContain("already sent");
    expect(await b.money()).toBe(funded);
  });

  it("a sticker or plain text gets the sandbox note and moves no money", async () => {
    const b = await bot();
    await b.send(12, { sticker: { file_id: "s" } });
    expect(b.said.at(-1)).toContain("Send a photo of a store receipt");
    expect(await b.money()).toBe(0);
  });

  it("a receipt in another currency is shown in that currency, says why, and moves no money", async () => {
    const b = await bot();
    const r = syntheticReceipt(b.rec, 302, [{ needId: "water", qty: 2, amount: 216 }], { currency: "USD" });
    b.files.usd = r.bytes;
    await b.send(13, { photo: [{ file_id: "usd" }] });
    const reply = b.said.at(-1)!;
    expect(reply).toContain("$2.16");
    expect(reply).not.toContain("¥");
    expect(reply).toContain("No money moves");
    expect(reply).not.toContain("No line matches");
    expect(await b.money()).toBe(0);
    expect(b.pp.captures).toEqual([]);
  });

  it("a receipt held for review tells the person they are the coordinator, in plain amounts", async () => {
    const b = await bot();
    const r = syntheticReceipt(b.rec, 303, [{ needId: "water", qty: 2, amount: 216 }], { totalMinor: 999, subtotalMinor: 999 });
    b.files.off = r.bytes;
    await b.send(15, { photo: [{ file_id: "off" }] });
    const reply = b.said.at(-1)!;
    expect(reply).toContain("its total does not match its lines");
    expect(reply).not.toContain("add up to");
    expect(reply).not.toContain("¥999 but");
    expect(reply).toContain("you are the coordinator");
    expect(reply).toContain("no money moves");
    expect(await b.money()).toBe(0);
  });

  it("a chat's own drive is reused, and new drives from one chat stop at the hourly limit", async () => {
    const b = await bot();
    const open = (driveId: string) => b.h.svc.createDemoDrive({ driveId, ip: "telegram:9", enforceLimit: true });
    for (let i = 0; i < b.h.svc.limits.demoDrivesPerHour; i++) await open(`demo-limit-${i}`);
    await expect(open("demo-limit-over")).rejects.toMatchObject({ code: "demo_limit" });
    await expect(open("demo-limit-0")).resolves.toBeTruthy();
  });

  it("a local run has no drive link to offer", async () => {
    const b = await bot();
    await handleTelegramUpdate(b.h.svc, { update_id: 14, message: { chat: { id: 78, type: "private" }, text: "/start" } }, { token: "T", baseUrl: "", fetch: async () => Response.json({ ok: true }) });
    expect(b.said).toEqual([]);
    const local: string[] = [];
    const tg = (async (_u: string, init?: RequestInit) => {
      if (init?.body) local.push(JSON.parse(String(init.body)).text ?? "");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await handleTelegramUpdate(b.h.svc, { update_id: 19, message: { chat: { id: 79, type: "private" }, text: "/start" } }, { token: "T", baseUrl: "", fetch: tg });
    expect(local.join(" ")).toContain("Send a photo");
    expect(local.join(" ")).not.toContain("local check");
    expect(local.join(" ")).not.toContain("http");
  });

  it("group chats and updates without a message are ignored, and a reply never carries the token", async () => {
    const b = await bot();
    await handleTelegramUpdate(b.h.svc, { update_id: 9, message: { chat: { id: 1, type: "group" }, text: "hi" } }, { token: "T", baseUrl: "https://x.example" });
    await handleTelegramUpdate(b.h.svc, { update_id: 10 }, { token: "T", baseUrl: "https://x.example" });
    await b.send(11, { text: "hello" });
    expect(b.said).toHaveLength(1);
    expect(b.said.join(" ")).not.toContain("TEST-TOKEN");
    expect((await b.h.db.db.select().from(events).where(eq(events.type, "LineFunded"))).length).toBe(0);
  });
});

describe("the coordinator's buttons", () => {
  /** A receipt the model calls hard to read: its lines add up, one line is alcohol. */
  async function held(b: Awaited<ReturnType<typeof bot>>, over = {}) {
    const r = syntheticReceipt(
      b.rec,
      401,
      [
        { needId: "water", qty: 2, amount: 216 },
        { needId: null, qty: 1, amount: 1198, verdict: "rejected", ruleCode: "alcohol" },
      ],
      { readability: "poor", ...over },
    );
    b.files.held = r.bytes;
    await b.send(30, { photo: [{ file_id: "held" }] });
    return b.bodies.at(-1)!;
  }
  const press = (b: Awaited<ReturnType<typeof bot>>, update_id: number, data: string, chatId = 77) =>
    handleTelegramUpdate(b.h.svc, { update_id, callback_query: { id: `q${update_id}`, data, message: { message_id: 5, chat: { id: chatId, type: "private" } } } }, b.deps);
  const buttons = (body: Record<string, unknown>) => (body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0];
  const answers = (b: Awaited<ReturnType<typeof bot>>) => b.calls.filter((c) => c.url.includes("/answerCallbackQuery")).map((c) => c.body.text as string);

  it("a hard-to-read receipt shows its lines in English and both buttons, and moves no money yet", async () => {
    const b = await bot();
    const body = await held(b);
    expect(body.text).toContain("the photo is hard to read");
    expect(body.text).toContain("1. Water 2 L · ¥216");
    expect(body.text).toContain("2. Alcohol · ¥1,198 · not funded");
    expect(buttons(body).map((x) => x.text)).toEqual(["Approve as coordinator", "Reject"]);
    expect(await b.money()).toBe(0);
  });

  it("Approve moves the money for the approved lines only, and takes the buttons away", async () => {
    const b = await bot();
    const data = buttons(await held(b))[0].callback_data;
    await press(b, 31, data);
    expect(await b.money()).toBe(1);
    expect(b.said.at(-1)).toContain("1 approved, 1 refused");
    expect(answers(b)).toEqual(["Approved."]);
    expect(b.calls.some((c) => c.url.includes("/editMessageReplyMarkup"))).toBe(true);
  });

  it("a second press changes nothing", async () => {
    const b = await bot();
    const data = buttons(await held(b))[0].callback_data;
    await press(b, 32, data);
    const funded = await b.money();
    const captures = b.pp.captures.length;
    await press(b, 33, data);
    await press(b, 33, data);
    expect(await b.money()).toBe(funded);
    expect(b.pp.captures.length).toBe(captures);
    expect(answers(b)).toEqual(["Approved.", "Already decided."]);
  });

  it("Reject moves nothing and Approve after it is refused", async () => {
    const b = await bot();
    const [approve, reject] = buttons(await held(b));
    await press(b, 34, reject.callback_data);
    expect(b.said.at(-1)).toContain("Rejected by the coordinator");
    await press(b, 35, approve.callback_data);
    expect(await b.money()).toBe(0);
    expect(answers(b)).toEqual(["Rejected.", "Already decided."]);
  });

  it("another chat cannot decide, whatever data it sends", async () => {
    const b = await bot();
    const data = buttons(await held(b))[0].callback_data;
    await press(b, 36, data, 12345);
    await press(b, 37, "approve:demo-1234.r1", 12345);
    await press(b, 38, data.replace("approve", "pay"));
    expect(await b.money()).toBe(0);
    expect(answers(b)).toEqual(["This button is not for this chat.", "This button is not for this chat.", "This button is not for this chat."]);
    const [row] = await b.h.db.db.select().from(receipts);
    expect(row.status).toBe("review");
  });

  it("a total that does not add up offers Reject only", async () => {
    const b = await bot();
    const body = await held(b, { totalMinor: 999, subtotalMinor: 999 });
    expect(buttons(body).map((x) => x.text)).toEqual(["Reject"]);
    expect(body.text).toContain("its total does not match its lines");
  });
});

describe("the webhook route", () => {
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, secret: process.env.TELEGRAM_WEBHOOK_SECRET };
  afterAll(() => {
    setServiceForTests(undefined);
    for (const [k, v] of [["TELEGRAM_BOT_TOKEN", saved.token], ["TELEGRAM_WEBHOOK_SECRET", saved.secret]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const post = (secret?: string) =>
    webhookPOST(new Request("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret }) },
      body: JSON.stringify({ update_id: 900, message: { chat: { id: 5, type: "group" }, text: "hi" } }),
    }));

  it("stays closed until it is configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect((await post("anything")).status).toBe(404);
  });

  it("refuses a forged secret and takes the right one", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch });
    setServiceForTests(h.svc);
    process.env.TELEGRAM_BOT_TOKEN = "TEST-TOKEN";
    process.env.TELEGRAM_WEBHOOK_SECRET = "right-secret-value";
    expect((await post()).status).toBe(401);
    expect((await post("wrong-secret-value")).status).toBe(401);
    expect((await post("short")).status).toBe(401);
    expect((await post("right-secret-value")).status).toBe(200);
  });
});
