import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseClient } from "../../src/receipts/bedrock";
import type { OcrEngine, OcrLine } from "../../src/receipts/ocr";
import { sha256Hex } from "../../src/receipts/hash";
import { LineBox } from "../../src/receipts/types";
import { demoDrive } from "../../src/server/demo";
import { ReceiptReading, SHIPPED_ANSWERS } from "../../src/server/reading";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, ROOT } from "./support/harness";

// Where each line of a receipt is printed travels from the reader to the drive view, and the sample receipt
// carries boxes measured once with Tesseract (tools/receipts/line-boxes.ts), so the demo never calls a model for them.

const sidecar = JSON.parse(readFileSync(path.join(ROOT, "eval/live/shipped/hero-ja-01.lines.json"), "utf8")) as { imageSha256: string; lineBoxes: unknown[] };

describe("the sample receipt's line boxes", () => {
  it("are measured on the sample photo itself: one valid box for each of its 11 lines", () => {
    expect(sidecar.imageSha256).toBe(SHIPPED_ANSWERS[0].imageSha256);
    const boxes = sidecar.lineBoxes.map((b) => LineBox.parse(b));
    expect(boxes.map((b) => b.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Printed top to bottom, inside the paper (the desk is around it), each one row high.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].box.y).toBeGreaterThan(boxes[i - 1].box.y);
    for (const { box } of boxes) {
      expect(box.x).toBeGreaterThan(0.1);
      expect(box.x + box.w).toBeLessThan(0.9);
      expect(box.h).toBeLessThan(0.04);
    }
    expect(SHIPPED_ANSWERS[0].lineBoxes).toEqual(boxes);
  });

  it("reach the drive view with the sample receipt, and a second copy of the photo keeps them", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, savedAnswers: SHIPPED_ANSWERS });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-boxes" })).drive.id;
    const first = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(first.lines.map((l) => l.box)).toEqual(SHIPPED_ANSWERS[0].lineBoxes!.map((b) => b.box));
    const again = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(again.reader).toBe("copy");
    expect(again.lines.map((l) => l.box)).toEqual(first.lines.map((l) => l.box));
    const v = await h.svc.getDriveView(driveId);
    expect(v.receipts[0].lines.find((l) => l.lineNo === 4)?.box).toEqual(SHIPPED_ANSWERS[0].lineBoxes!.find((b) => b.lineNo === 4)?.box);
  });

  it("a reading without boxes (the truth files in tests) stores none, and the view says null", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, savedAnswers: [] });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-noboxes" })).drive.id;
    const r = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(r.reader).toBe("recorded");
    expect(r.lines.every((l) => l.box === null)).toBe(true);
  });
});

describe("a live OCR reading keeps its boxes", () => {
  it("the OCR pipeline's boxes are part of the reading the service stores", async () => {
    const w = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 0.1, h: 0.02 } });
    const rows: OcrLine[] = [
      { text: "ミナト生活館", box: { x: 0.2, y: 0.05, w: 0.5, h: 0.02 }, words: [w("ミナト生活館", 0.2, 0.05)] },
      { text: "雪解けの水 2L ¥472", box: { x: 0.1, y: 0.3, w: 0.8, h: 0.02 }, words: [w("雪解けの水", 0.1, 0.3), w("¥472", 0.8, 0.3)] },
      ...["北空店", "空川県北空市", "レジ", "TEL"].map((t, i) => ({ text: t, box: { x: 0.2, y: 0.06 + i / 100, w: 0.5, h: 0.01 }, words: [w(t, 0.2, 0.06 + i / 100)] })),
    ];
    const engine: OcrEngine = { recognize: async () => rows, close: async () => {} };
    const structure = "RECEIPT: merchant=ミナト生活館; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good\nLINE: no=1; qty=4; unit=118; amount=472; text=雪解けの水 2L; en=Snowmelt water 2L";
    const client: ConverseClient = {
      async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
        const tool = cmd.input.toolConfig?.tools?.[0]?.toolSpec?.name;
        const image = cmd.input.messages?.[0].content?.some((b) => b.image);
        const content = tool ? [{ toolUse: { toolUseId: "t1", name: tool, input: { lines: "no=1; need=water; qty=4; verdict=eligible; conf=0.9; why=Water." } as never } }] : [{ text: image ? "¥472" : structure }];
        return { output: { message: { role: "assistant", content } }, stopReason: tool ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, metrics: { latencyMs: 1 }, $metadata: {} };
      },
    };
    const h = await harness({ fetch: fakeSandbox().fetch });
    // Another photo to the reader (one pixel changed): no saved answer, no recording.
    const png = PNG.sync.read(Buffer.from(heroBytes()));
    png.data[0] ^= 1;
    const bytes = new Uint8Array(PNG.sync.write(png));
    const { drive, needs } = demoDrive("demo-live-boxes", h.clock.now());
    const reading = new ReceiptReading(h.db.db, { answers: [], recordings: { readings: {}, classifications: {} } }, { liveReadsPerDay: 5, spendCapUsd: 5, liveReadMs: 30_000 }, { pipeline: "ocr-lite", bedrock: () => client, ocr: () => engine });
    const out = await reading.read({ driveId: "demo-live-boxes", image: { bytes, mediaType: "image/png" }, sha256: sha256Hex(bytes), needs, rules: drive.rules, baseCurrency: drive.baseCurrency, ipHash: "x", now: h.clock.now() });
    expect(out.reader).toBe("live:ocr-lite");
    expect(out.lineBoxes?.map((b) => b.lineNo)).toEqual([1]);
  });
});
