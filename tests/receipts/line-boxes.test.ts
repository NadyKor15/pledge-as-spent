import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseClient } from "../../src/receipts/bedrock";
import { matchLineBoxes, OcrNovaReader, type OcrEngine, type OcrLine } from "../../src/receipts/ocr";
import { JsonlSpendLedger, SpendCap } from "../../src/receipts/spend";
import { LineBox } from "../../src/receipts/types";
import { SHIPPED_ANSWERS } from "../../src/server/reading";
import { receiptView } from "../../src/server/views";

// The proof cell cuts a receipt's line out of its published photo. These are the boxes it cuts by:
// one per parsed line, from the OCR row the line was read from, and none rather than a wrong one.

const ROOT = path.resolve(__dirname, "../..");
const shipped = JSON.parse(readFileSync(path.join(ROOT, "eval/live/shipped/hero-ja-01.json"), "utf8")) as {
  reading: { lines: { lineNo: number; rawText: string; amountMinor: number }[] };
  trace: { reread: string[] };
};
const row = (text: string, i: number, n = 50): OcrLine => ({ text, box: { x: 0.1, y: i / n, w: 0.8, h: 0.8 / n }, words: [] });

describe("matchLineBoxes", () => {
  it("places each line on the row that prints its amount and its name, in print order", () => {
    const rows = ["ミナト生活館", "北空の天然水 2L ¥798※", "6 本ケース", "雪解けの水 2L ¥472※", "4 点 x 単 118", "合計 ¥1,270"].map((t, i) => row(t, i));
    const lines = [
      { lineNo: 1, rawText: "北空の天然水 2L 6 本ケース", amountMinor: 798 },
      { lineNo: 2, rawText: "雪解けの水 2L", amountMinor: 472 },
    ];
    expect(matchLineBoxes(lines, rows, 0)).toEqual([
      { lineNo: 1, box: rows[1].box },
      { lineNo: 2, box: rows[3].box },
    ]);
  });

  it("gives no box to a line whose amount is printed on no row, or whose row names something else", () => {
    const rows = ["缶ビール 350ml 6 缶 ¥1,198", "ギフトカード ¥3,000"].map((t, i) => row(t, i));
    const lines = [
      { lineNo: 1, rawText: "缶ビール 350ml 6 缶", amountMinor: 1200 },
      { lineNo: 2, rawText: "単3 電池 10 本入", amountMinor: 3000 },
    ];
    expect(matchLineBoxes(lines, rows, 0)).toEqual([]);
  });

  it("two lines alike get a row each, never the same one twice", () => {
    const rows = ["単 3 ばら ¥98", "単 3 ばら ¥98", "単 3 ばら ¥98"].map((t, i) => row(t, i));
    const lines = [
      { lineNo: 1, rawText: "単 3 ばら", amountMinor: 98 },
      { lineNo: 2, rawText: "単 3 ばら", amountMinor: 98 },
    ];
    expect(matchLineBoxes(lines, rows, 0).map((b) => b.box.y)).toEqual([0, 1 / 50]);
  });

  it("a quantity row is never a line's row, though it prints a number", () => {
    const rows = ["2 点 x 単 398", "単 3 電池 10 本入 ¥796"].map((t, i) => row(t, i));
    expect(matchLineBoxes([{ lineNo: 1, rawText: "単 3 電池 10 本入", amountMinor: 796 }], rows, 0)).toEqual([{ lineNo: 1, box: rows[1].box }]);
    expect(matchLineBoxes([{ lineNo: 1, rawText: "2 点 x 単", amountMinor: 398 }], rows, 0)).toEqual([]);
  });

  it("a discount line matches its row by the amount without its sign; cents count on a dollar receipt", () => {
    const rows = ["MILK 2% GAL 3.49", "COUPON MILK -0.50", "TOTAL 2.99"].map((t, i) => row(t, i));
    const lines = [
      { lineNo: 1, rawText: "MILK 2% GAL", amountMinor: 349 },
      { lineNo: 2, rawText: "COUPON MILK", amountMinor: -50 },
    ];
    expect(matchLineBoxes(lines, rows, 2).map((b) => b.lineNo)).toEqual([1, 2]);
  });

  it("keeps a box inside the photo and drops one with no area", () => {
    const rows: OcrLine[] = [
      { text: "雪解けの水 2L ¥472", box: { x: -0.02, y: 0.3, w: 1.1, h: 0.02 }, words: [] },
      { text: "ミネラルウォーター ¥216", box: { x: 0.1, y: 0.4, w: 0.5, h: 0 }, words: [] },
    ];
    const out = matchLineBoxes(
      [
        { lineNo: 1, rawText: "雪解けの水 2L", amountMinor: 472 },
        { lineNo: 2, rawText: "ミネラルウォーター", amountMinor: 216 },
      ],
      rows,
      0,
    );
    expect(out).toHaveLength(1);
    const b = LineBox.parse(out[0]).box;
    expect([b.x, b.y, b.w, b.h].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 0.3, 1, 0.02]);
  });

  it("on the sample receipt's own OCR rows, all 11 lines find their product rows", () => {
    const rows = shipped.trace.reread.map((t, i) => row(t, i, shipped.trace.reread.length));
    const out = matchLineBoxes(shipped.reading.lines, rows, 0);
    const at = (lineNo: number) => rows.findIndex((r) => r.box === out.find((b) => b.lineNo === lineNo)?.box);
    expect(out.map((b) => b.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(shipped.reading.lines.map((l) => rows[at(l.lineNo)].text)).toEqual([
      "北空の天然水 2L ¥798※",
      "雪解けの水 2L ¥472※",
      "ミネラルウォーター ¥216※",
      "ソフトキッズおおむつ M 44 枚 ¥2,596",
      "ベビーラプがッツ M ¥3,294",
      "紙おむつ M 18 枚 ¥598",
      "アルカリ乾電池単 3 2 本入 ¥698",
      "単 3 電池 1 本入 ¥796",
      "単 3 ばら ¥980",
      "缶ピール 350m 6 缶 ¥1,198",
      "ギフトカード 3,000 ¥3,000",
    ]);
  });
});

describe("the OCR reader returns the boxes with the reading", () => {
  const image = { bytes: new Uint8Array(readFileSync(path.join(ROOT, "eval/receipts/hero/hero-ja-01.png"))), mediaType: "image/png" as const };
  const reply = (text: string): ConverseCommandOutput =>
    ({ output: { message: { role: "assistant", content: [{ text }] } }, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, metrics: { latencyMs: 1 }, $metadata: {} }) as ConverseCommandOutput;

  it("one box per line, mapped from the prepared image back onto the photo", async () => {
    const w = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 0.1, h: 0.02 } });
    const lines: OcrLine[] = [
      { text: "ミナト生活館", box: { x: 0.2, y: 0.05, w: 0.5, h: 0.02 }, words: [w("ミナト生活館", 0.2, 0.05)] },
      { text: "雪解けの水 2L ¥472", box: { x: 0.1, y: 0.3, w: 0.8, h: 0.02 }, words: [w("雪解けの水", 0.1, 0.3), w("2L", 0.4, 0.3), w("¥472", 0.8, 0.3)] },
      ...["北空店", "空川県北空市", "レジ", "TEL"].map((t, i) => ({ text: t, box: { x: 0.2, y: 0.06 + i / 100, w: 0.5, h: 0.01 }, words: [w(t, 0.2, 0.06 + i / 100)] })),
    ];
    const engine: OcrEngine = { recognize: async () => lines, close: async () => {} };
    const answer = "RECEIPT: merchant=ミナト生活館; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good\nLINE: no=1; qty=4; unit=118; amount=472; text=雪解けの水 2L";
    let n = 0;
    const client: ConverseClient = { send: async () => reply(++n < 3 ? "¥472" : answer) };
    const cap = new SpendCap(new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "lb-")), "l.jsonl")));
    const out = await new OcrNovaReader({ client, cap, engine }).read(image, { currency: "JPY", languages: ["ja", "en"] });
    expect(out.lineBoxes).toHaveLength(1);
    const b = LineBox.parse(out.lineBoxes![0]).box;
    // The paper sits inside the photo with a desk around it: the row's box on the photo is narrower than on the paper.
    expect(b.w).toBeLessThan(0.8);
    expect(b.y).toBeGreaterThan(0.2);
    expect(b.y).toBeLessThan(0.45);
  });
});

describe("the drive view gives each line its box", () => {
  const base = {
    id: "d.r1",
    driveId: "d",
    status: "funded",
    channel: "web",
    reader: "cached:ocr-pro",
    uploadedAt: "2026-11-01T00:00:00Z",
    sha256: "x",
    dhash: null,
    semanticKey: null,
    mediaType: "image/png",
    ipHash: null,
    decision: null,
    classified: null,
    parsed: { ...SHIPPED_ANSWERS[0].reading },
    published: true,
  };
  const view = (checks: unknown) => receiptView({ ...base, checks } as never);

  it("from the stored boxes, by line number; a line without one has none", () => {
    const v = view({ flags: [], lineBoxes: [{ lineNo: 4, box: { x: 0.1, y: 0.4, w: 0.7, h: 0.02 } }] });
    expect(v.lines.find((l) => l.lineNo === 4)?.box).toEqual({ x: 0.1, y: 0.4, w: 0.7, h: 0.02 });
    expect(v.lines.filter((l) => l.box !== null)).toHaveLength(1);
  });

  it("a receipt read before boxes were kept, and a box that is not one, show none", () => {
    expect(view({ flags: [] }).lines.every((l) => l.box === null)).toBe(true);
    expect(view(null).lines.every((l) => l.box === null)).toBe(true);
    const bad = view({ lineBoxes: [{ lineNo: 4, box: { x: 0.9, y: 0.4, w: 0.7, h: 0.02 } }, { lineNo: 5, box: { x: 0.1, y: 0.4, w: 0, h: 0.02 } }, { lineNo: 6 }, "x"] });
    expect(bad.lines.every((l) => l.box === null)).toBe(true);
  });
});
