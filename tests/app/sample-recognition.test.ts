import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { drives, events } from "../../src/db/schema";
import type { ConverseClient } from "../../src/receipts/bedrock";
import { dHash, hammingHex } from "../../src/receipts/hash";
import { SAMPLE_MAX_DISTANCE, SHIPPED_ANSWERS } from "../../src/server/reading";
import { handleTelegramUpdate } from "../../src/server/telegram";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings, ROOT } from "./support/harness";

// The photo the bot really received for the sample: recompressed by Telegram, so its bytes differ from the sample's.
const PHOTO = new Uint8Array(readFileSync(path.join(ROOT, "tests/fixtures/hero-telegram.jpg")));

function counting() {
  let calls = 0;
  const client: ConverseClient = {
    async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
      void cmd;
      calls += 1;
      return { output: { message: { role: "assistant", content: [{ text: "no receipt here" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as ConverseCommandOutput;
    },
  };
  return { client, calls: () => calls };
}

async function setup() {
  const model = counting();
  const h = await harness({ fetch: fakeSandbox().fetch, recordings: loadRecordings(), savedAnswers: SHIPPED_ANSWERS, bedrock: () => model.client, pipeline: "nova-lite" });
  await h.svc.createDemoDrive({ driveId: "demo-sample" });
  return { h, model };
}

describe("the sample receipt after a messenger recompressed it", () => {
  it("on a demo drive gets its saved reading, says so, and calls no model", async () => {
    const { h, model } = await setup();
    const { receipt } = await h.svc.submitReceipt({ driveId: "demo-sample", bytes: PHOTO, channel: "telegram" });
    expect(receipt.reader).toBe("recognized:ocr-pro");
    expect(receipt.status).toBe("funded");
    expect(receipt.total).toBe(14646);
    expect(model.calls()).toBe(0);
  });

  it("recognized by its look, not its bytes: the saved reading, but no line boxes (they were measured on the sample's own pixels)", async () => {
    const { h } = await setup();
    expect(SHIPPED_ANSWERS[0].lineBoxes?.length).toBeGreaterThan(0); // the sample has boxes to give, so none below is a choice
    const { receipt } = await h.svc.submitReceipt({ driveId: "demo-sample", bytes: PHOTO, channel: "telegram" });
    expect(receipt.reader).toBe("recognized:ocr-pro");
    expect(receipt.lines.length).toBeGreaterThan(0);
    expect(receipt.lines.every((l) => l.box === null)).toBe(true);
    // Its rows too were measured on the sample's own pixels: a look-alike is not closed by them, so no photo is shown.
    expect(SHIPPED_ANSWERS[0].closing?.bands.length).toBeGreaterThan(0);
    expect(receipt.image).toMatchObject({ published: false });
    expect(await h.svc.getReceiptImage(receipt.id)).toBeNull();
  });

  it("on a real drive is read live like any other photo", async () => {
    const { h, model } = await setup();
    await h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, "demo-sample"));
    await expect(h.svc.submitReceipt({ driveId: "demo-sample", bytes: PHOTO })).rejects.toMatchObject({ code: "unreadable_by_model" });
    expect(model.calls()).toBeGreaterThan(0);
    expect((await h.db.db.select().from(events)).filter((e) => e.type === "LineFunded")).toEqual([]);
  });

  it("the bot says it recognized the sample and that your own photo is read live", async () => {
    const { h } = await setup();
    const said: string[] = [];
    const tg = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/sendMessage")) said.push(JSON.parse(String(init?.body)).text);
      if (init?.body) return Response.json({ ok: true });
      if (String(url).includes("getFile")) return Response.json({ ok: true, result: { file_path: "photos/p.jpg" } });
      return new Response(Buffer.from(PHOTO));
    }) as unknown as typeof fetch;
    await handleTelegramUpdate(h.svc, { update_id: 1, message: { chat: { id: 5, type: "private" }, photo: [{ file_id: "p", width: 624, height: 1280 }] } }, { token: "T", baseUrl: "", fetch: tg });
    expect(said.at(-1)).toContain("I recognized our sample receipt");
    expect(said.at(-1)).toContain("A photo of your own is read live");
    expect(said.at(-1)).toContain("9 approved, 2 refused");
    expect(said.at(-1)).toContain("¥10,448");
  });
});

describe("the threshold", () => {
  const sample = SHIPPED_ANSWERS[0].imageDHash!;
  const look = (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg") => dHash({ bytes, mediaType })!;

  it("takes the recompressed sample", () => {
    expect(hammingHex(sample, look(PHOTO, "image/jpeg"))).toBeLessThanOrEqual(SAMPLE_MAX_DISTANCE);
  });

  it("takes no other receipt of the benchmark, with a wide margin", () => {
    const distances: number[] = [];
    for (const set of ["v1", "holdout", "adversarial"]) {
      const dir = path.join(ROOT, "eval/receipts", set);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".png"))) distances.push(hammingHex(sample, look(new Uint8Array(readFileSync(path.join(dir, f))), "image/png")));
    }
    expect(distances.length).toBeGreaterThan(50);
    expect(Math.min(...distances)).toBeGreaterThan(SAMPLE_MAX_DISTANCE * 3);
  });
});
