import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { events, receipts } from "../../src/db/schema";
import type { ConverseClient } from "../../src/receipts/bedrock";
import { POST as webhookPOST } from "../../src/app/api/telegram/webhook/route";
import { setServiceForTests } from "../../src/server/runtime";
import { handleTelegramUpdate } from "../../src/server/telegram";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";
import { noisePng, syntheticReceipt } from "./support/synthetic";

/** A model that answers without a receipt, as Nova does for a picture that is not one. */
const notAReceipt: ConverseClient = {
  async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
    void cmd;
    return { output: { message: { role: "assistant", content: [{ text: "I see no receipt in this picture." }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as ConverseCommandOutput;
  },
};

async function bot(files: Record<string, Uint8Array> = {}) {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec, bedrock: () => notAReceipt, pipeline: "nova-lite" });
  const said: string[] = [];
  const urls: string[] = [];
  const tg = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).includes("/sendChatAction")) return Response.json({ ok: true });
    if (String(url).includes("/sendMessage")) {
      said.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true });
    }
    const m = /getFile\?file_id=(.+)$/.exec(String(url));
    if (m) return Response.json({ ok: true, result: { file_path: `photos/${m[1]}` } });
    const name = String(url).split("/").pop()!;
    return new Response(Buffer.from(files[name]));
  }) as unknown as typeof fetch;
  const deps = { token: "TEST-TOKEN", baseUrl: "https://demo.example", fetch: tg };
  const send = (update_id: number, message: Record<string, unknown>) => handleTelegramUpdate(h.svc, { update_id, message: { chat: { id: 77, type: "private" }, ...message } }, deps);
  const money = async () => (await h.db.db.select().from(events)).filter((e) => e.type === "LineFunded").length;
  return { h, pp, rec, files, said, urls, send, money };
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
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(0);
    expect(await b.money()).toBe(0);
  });

  it("a file that is no image at all is refused before anything is read", async () => {
    const b = await bot();
    await b.send(5, { document: { file_id: "doc", mime_type: "application/pdf" } });
    expect(b.said.at(-1)).toContain("photo of a receipt");
    expect(b.urls.some((u) => u.includes("getFile"))).toBe(false);
  });

  it("a file of unknown type is judged by its bytes", async () => {
    const b = await bot({ hero: heroBytes(), junk: new TextEncoder().encode("this is not an image") });
    await b.send(16, { document: { file_id: "hero", mime_type: "application/octet-stream" } });
    expect(b.said.at(-1)).toContain("9 approved, 2 refused");
    await b.send(17, { document: { file_id: "junk", mime_type: "application/octet-stream" } });
    expect(b.said.at(-1)).not.toContain("approved");
    expect(await b.h.db.db.select().from(receipts)).toHaveLength(1);
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
    expect(b.said.at(-1)).toContain("already uploaded");
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
    expect(reply).toContain("add up to ¥216 but the printed total is ¥999");
    expect(reply).not.toContain("allowed");
    expect(reply).toContain("you are the coordinator");
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
    const drives = (await b.h.db.db.select().from(events)).map((e) => e.driveId);
    expect(drives.every((d) => d?.startsWith("demo-tg-"))).toBe(true);
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
