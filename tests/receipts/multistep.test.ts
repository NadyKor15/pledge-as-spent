import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseClient } from "../../src/receipts/bedrock";
import { OcrNovaReader, TesseractEngine, groundNumbers, groundReceipt, locateText, printedDate, tesseractLanguages, tidyOcrText, type OcrEngine, type OcrLine } from "../../src/receipts/ocr";
import { findPaper, prepImage } from "../../src/receipts/prep";
import { JsonlSpendLedger, SpendCap } from "../../src/receipts/spend";
import { foldText, mergeRows, similarity } from "../../src/receipts/text";
import { TwoPassReader, parseTranscription } from "../../src/receipts/twopass";
import { iou } from "../../tools/eval/metrics";
import { Truth } from "../../tools/receipts/truth";

const ROOT = path.resolve(__dirname, "../../eval/receipts");
const truth = (set: string, id: string) => Truth.parse(JSON.parse(readFileSync(path.join(ROOT, set, `${id}.truth.json`), "utf8")));
const image = (set: string, id: string) => ({ bytes: new Uint8Array(readFileSync(path.join(ROOT, set, `${id}.png`))), mediaType: "image/png" as const });
const hint = { currency: "JPY" as const, languages: ["ja", "en"] };

function reply(text: string, usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }): ConverseCommandOutput {
  return { output: { message: { role: "assistant", content: [{ text }] } }, stopReason: "end_turn", usage, metrics: { latencyMs: 1 }, $metadata: {} } as ConverseCommandOutput;
}
function scripted(answers: string[]) {
  const sent: ConverseCommand[] = [];
  const client: ConverseClient = { send: async (c) => (sent.push(c), reply(answers[sent.length - 1] ?? "")) };
  const cap = new SpendCap(new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "ms-")), "l.jsonl")));
  return { client, cap, sent };
}
const textOf = (c: ConverseCommand) => (c.input.messages?.[0].content ?? []).map((b) => b.text ?? "").join("\n");

describe("text helpers", () => {
  it("folds and compares", () => {
    expect(foldText("ﾐﾅﾄ 生活館!")).toBe("ミナト生活館");
    expect(similarity("¥1,298", "1298")).toBe(1);
    expect(similarity("abcd", "abxd")).toBeCloseTo(0.75);
  });
  it("merges tile rows by their overlap, fuzzily, and keeps a repeated line that is not in the overlap", () => {
    const a = ["store", "water 2L ¥128", "water 2L ¥128", "rice ¥300", "milk ¥200"];
    const b = ["rice ¥300", "milk ¥2O0", "bread ¥150", "water 2L ¥128"];
    expect(mergeRows(a, b)).toEqual([...a, "bread ¥150", "water 2L ¥128"]);
  });
  it("appends everything when the tiles share no rows, and ignores a lone short row", () => {
    expect(mergeRows(["a one", "b two"], ["c three", "d four"])).toEqual(["a one", "b two", "c three", "d four"]);
    expect(mergeRows(["----", "milk ¥200"], ["TOTAL", "x"])).toEqual(["----", "milk ¥200", "TOTAL", "x"]);
    expect(mergeRows([], ["a"])).toEqual(["a"]);
  });
});

describe("image preparation", () => {
  it("finds a bright paper on a dark desk, scales and maps boxes back", () => {
    const W = 400;
    const H = 600;
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const paper = x >= 100 && x < 300 && y >= 100 && y < 500;
        const text = paper && y % 20 < 3 && x > 120 && x < 280;
        const v = text ? 40 : paper ? 235 : 70;
        const i = (y * W + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
        png.data[i + 3] = 255;
      }
    const img = { bytes: new Uint8Array(PNG.sync.write(png)), mediaType: "image/png" as const };
    const box = findPaper({ width: W, height: H, data: new Uint8Array(png.data) });
    expect(Math.abs(box.x0 - 100)).toBeLessThanOrEqual(8);
    expect(Math.abs(box.x1 - 300)).toBeLessThanOrEqual(8);
    expect(Math.abs(box.y0 - 100)).toBeLessThanOrEqual(8);
    expect(Math.abs(box.y1 - 500)).toBeLessThanOrEqual(8);
    const p = prepImage(img, { scale: 2, margin: 0 });
    expect(p.tiltDeg).toBe(0);
    expect(Math.abs(p.image.width - 400)).toBeLessThanOrEqual(20);
    // The prepared image's centre is the paper's centre in the photo.
    const c = p.toOriginal({ x: 0.5, y: 0.5, w: 0, h: 0 });
    expect(c.x * W).toBeCloseTo(200, -1);
    expect(c.y * H).toBeCloseTo(300, -1);
    expect(p.tiles()).toHaveLength(2); // twice as tall as wide
  });

  it("straightens real photos: the tilt found matches the tilt the photo was made with", () => {
    for (const [set, id] of [["hero", "hero-ja-01"], ["v1", "v1-ja-02"], ["v1", "v1-tr-02"], ["v1", "v1-en-05"], ["v1", "v1-es-01"]] as const) {
      const t = truth(set, id);
      const p = prepImage(image(set, id));
      expect(Math.abs(p.tiltDeg - t.spec.photo.rotZ), id).toBeLessThan(1.0);
      const whole = p.toOriginal({ x: 0, y: 0, w: 1, h: 1 });
      expect(whole.w * whole.h, id).toBeGreaterThan(0.35);
      expect(whole.w * whole.h, id).toBeLessThan(0.95);
    }
  });

  it("cuts tall receipts into overlapping tiles and maps tile boxes to the photo", () => {
    const p = prepImage(image("hero", "hero-ja-01"));
    const tiles = p.tiles();
    expect(tiles).toHaveLength(2);
    const overlap = (tiles[0].y1 - tiles[1].y0) / (tiles[0].y1 - tiles[0].y0);
    expect(overlap).toBeGreaterThan(0.1);
    expect(overlap).toBeLessThan(0.2);
    expect(tiles[1].y1).toBe(p.image.height);
    // The same prepared point, reached from the whole image and from a tile, lands on the same photo point.
    const yPrepared = tiles[1].y0 + 100;
    const viaTile = tiles[1].toOriginal({ x: 0.5, y: 100 / (tiles[1].y1 - tiles[1].y0), w: 0, h: 0 });
    const viaWhole = p.toOriginal({ x: 0.5, y: yPrepared / p.image.height, w: 0, h: 0 });
    expect(viaTile.x).toBeCloseTo(viaWhole.x, 3);
    expect(viaTile.y).toBeCloseTo(viaWhole.y, 3);
    for (const t of tiles) expect(t.bytes[0]).toBe(0xff); // JPEG
  });

  it("rejects what it cannot decode", () => {
    expect(() => prepImage({ bytes: new Uint8Array(4), mediaType: "image/webp" })).toThrow(/cannot decode/);
  });
});

describe("OCR helpers", () => {
  const w = (text: string, x: number, y = 0.5): { text: string; box: { x: number; y: number; w: number; h: number } } => ({ text, box: { x, y, w: 0.1, h: 0.02 } });
  const line = (words: ReturnType<typeof w>[]): OcrLine => ({ text: words.map((x) => x.text).join(" "), box: { x: words[0].box.x, y: words[0].box.y, w: 0.5, h: 0.02 }, words });

  it("names the Tesseract languages, always with English", () => {
    expect(tesseractLanguages(["ja", "en"])).toBe("eng+jpn");
    expect(tesseractLanguages(["tr"])).toBe("eng+tur");
    expect(tesseractLanguages(["es", "en"])).toBe("eng+spa");
    expect(tesseractLanguages(["xx"])).toBe("eng");
  });

  it("tidies what OCR does to Japanese text, the yen sign and thousands", () => {
    expect(tidyOcrText("北空 の 天然水 2L \\798※")).toBe("北空の天然水 2L ¥798※");
    expect(tidyOcrText("¥3, 000  ")).toBe("¥3,000");
    expect(tidyOcrText("合計 ¥6 , 431")).toBe("合計 ¥6,431");
    expect(tidyOcrText("2 点 x 単 1.298")).toBe("2 点 x 単 1.298"); // a digit next to a character keeps its space
  });

  it("finds personal data among the OCR words: a label is not part of the box, a mask is matched by its digits, near misses count, others do not", () => {
    const lines = [line([w("会員番号", 0.1, 0.8), w("3216", 0.4, 0.8), w("2141", 0.5, 0.8), w("5525", 0.6, 0.8)]), line([w("キネネネ9591.", 0.6, 0.7)]), line([w("ミシマ", 0.2, 0.6), w("レン", 0.3, 0.6)])];
    const member = locateText(lines, "会員番号 3216 2141 5525")!;
    expect(member.x).toBeCloseTo(0.4);
    expect(member.w).toBeCloseTo(0.3);
    expect(locateText(lines, "************9591")).toMatchObject({ x: 0.6, y: 0.7 });
    expect(locateText(lines, "ミシマ レン")).toMatchObject({ x: 0.2 });
    expect(locateText(lines, "TOTALLY OTHER")).toBeNull();
    expect(locateText(lines, "12")).toBeNull();
  });

  it("puts an amount the model made up back to the number printed on the product's row, and leaves printed amounts alone", () => {
    const ocr = [line([w("北空の天然水", 0.1, 0.1), w("2L", 0.3, 0.1), w("¥798※", 0.8, 0.1)]), line([w("6本ケース", 0.1, 0.12)]), line([w("牛乳", 0.1, 0.2), w("¥1,298", 0.8, 0.2)]), line([w("値引", 0.1, 0.3), w("-¥100", 0.8, 0.3)])];
    const lines = [
      { rawText: "北空の天然水 2L", amountMinor: 4788 }, // 798 x 6
      { rawText: "牛乳", amountMinor: 1298 },
      { rawText: "値引", amountMinor: -100 },
      { rawText: "unknown thing", amountMinor: 555 },
      { rawText: "牛乳", amountMinor: "x" as unknown as number },
    ];
    expect(groundNumbers(lines, ocr, 0).map((l) => l.amountMinor)).toEqual([798, 1298, -100, 555, "x"]);
  });

  it("drops a unit price and a quantity the text does not support", () => {
    const ocr = [line([w("AA", 0.1, 0.1), w("$23.97", 0.8, 0.1)]), line([w("3", 0.1, 0.12), w("@", 0.2, 0.12), w("$7.99", 0.8, 0.12)])];
    const out = groundNumbers([{ rawText: "AA", amountMinor: 2397, unitPriceMinor: 2997, qty: 8 }, { rawText: "AA", amountMinor: 2397, unitPriceMinor: 799, qty: 0 }], ocr, 2);
    // The row below the product decides; the second line has no row of its own: a quantity of 0 is replaced by amount / unit price when that divides evenly (2397 / 799 = 3).
    expect(out.map((l) => [l.unitPriceMinor, l.qty])).toEqual([[799, 3], [799, 3]]);
    const none = groundNumbers([{ rawText: "AA", amountMinor: 2397, unitPriceMinor: 2997, qty: 0 }], [line([w("BB", 0.1, 0.1), w("$1.00", 0.8, 0.1)])], 2);
    expect(none.map((l) => [l.unitPriceMinor, l.qty])).toEqual([[null, null]]);
  });

  it("takes the text from the product's row with the rows that continue its name, and a quantity only from a quantity row", () => {
    const ocr = [line([w("ミネラルウォーター", 0.1, 0.1), w("¥216※", 0.8, 0.1)]), line([w("2L", 0.1, 0.12), w("ペット", 0.2, 0.12)]), line([w("2", 0.1, 0.14), w("点", 0.15, 0.14), w("x", 0.2, 0.14), w("単", 0.25, 0.14), w("108", 0.3, 0.14)]), line([w("北空の天然水", 0.1, 0.2), w("2L", 0.3, 0.2), w("¥798※", 0.8, 0.2)]), line([w("6", 0.1, 0.22), w("本ケース", 0.15, 0.22)]), line([w("単3", 0.1, 0.3), w("¥980", 0.8, 0.3)]), line([w("小計", 0.1, 0.4), w("¥1,994", 0.8, 0.4)]), line([w("お試し", 0.1, 0.42)])];
    const out = groundNumbers(
      [
        { rawText: "ミネラルウォーター", amountMinor: 216, unitPriceMinor: 216, qty: 1 },
        { rawText: "北空の天然水 2L", amountMinor: 798, unitPriceMinor: null, qty: 6 }, // a model takes the 6 from the pack
        { rawText: "単3", amountMinor: 980, unitPriceMinor: null, qty: 1 },
      ],
      ocr,
      0,
    );
    expect(out.map((l) => l.rawText)).toEqual(["ミネラルウォーター 2L ペット", "北空の天然水 2L 6 本ケース", "単3"]);
    expect(out.map((l) => [l.qty, l.unitPriceMinor])).toEqual([[2, 108], [1, null], [1, null]]);
  });

  it("puts back a product row the model left out, at its place, and not a quantity, subtotal or footer row", () => {
    const ocr = [line([w("店", 0.1, 0.05)]), line([w("牛乳", 0.1, 0.1), w("¥200", 0.8, 0.1)]), line([w("単3電池", 0.1, 0.2), w("¥796", 0.8, 0.2)]), line([w("2", 0.1, 0.22), w("点", 0.15, 0.22), w("x", 0.2, 0.22), w("単398", 0.3, 0.22)]), line([w("ギフトカード", 0.1, 0.3), w("¥3,000", 0.8, 0.3)]), line([w("小計", 0.1, 0.4), w("¥3,996", 0.8, 0.4)]), line([w("合計", 0.1, 0.5), w("¥3,996", 0.8, 0.5)])];
    const obj = { currency: "JPY", subtotalMinor: 3996, lines: [{ rawText: "牛乳", amountMinor: 200, lineNo: 1 }, { rawText: "ギフトカード", amountMinor: 3000, lineNo: 2 }] };
    const out = groundReceipt(obj, ocr).lines as { rawText: string; amountMinor: number; lineNo: number; qty: number }[];
    expect(out.map((l) => [l.lineNo, l.rawText, l.amountMinor, l.qty])).toEqual([[1, "牛乳", 200, 1], [2, "単3電池", 796, 2], [3, "ギフトカード", 3000, 1]]);
  });

  it("takes the amount from the product's own row, not from a unit price or a quantity row, and uses each row once", () => {
    const ocr = [line([w("AGUA", 0.1, 0.1), w("MINERAL", 0.3, 0.1), w("3,54", 0.8, 0.1), w("B", 0.9, 0.1)]), line([w("6", 0.1, 0.12), w("x", 0.2, 0.12), w("0,59", 0.8, 0.12)]), line([w("AGUA", 0.1, 0.2), w("MINERAL", 0.3, 0.2), w("7,08", 0.8, 0.2)])];
    const out = groundNumbers([{ rawText: "AGUA MINERAL 1,5L", amountMinor: 59, unitPriceMinor: 59, qty: 6 }, { rawText: "AGUA MINERAL 1,5L", amountMinor: 354, unitPriceMinor: null, qty: 1 }], ocr, 2);
    expect(out.map((l) => l.amountMinor)).toEqual([354, 708]);
    expect(out[0].qty).toBe(6); // 354 / 59 = 6
  });

  it("repairs a quantity OCR misread against amount and unit price", () => {
    const ocr = [line([w("単3", 0.1, 0.1), w("ばら", 0.2, 0.1), w("¥980", 0.8, 0.1)]), line([w("10点", 0.1, 0.12), w("x", 0.2, 0.12), w("単98", 0.8, 0.12)])];
    expect(groundNumbers([{ rawText: "単3 ばら", amountMinor: 980, unitPriceMinor: 98, qty: 104 }], ocr, 0)[0].qty).toBe(10);
  });

  it("does not read 3, 000 as 0", () => {
    const ocr = [line([w("ギフトカード", 0.1, 0.5), w("¥3,000", 0.8, 0.5)])];
    expect(groundNumbers([{ rawText: "ギフトカード", amountMinor: 3000 }], ocr, 0)[0].amountMinor).toBe(3000);
  });
});

describe("OcrNovaReader", () => {
  const w = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 0.1, h: 0.02 } });
  const lines: OcrLine[] = [
    { text: "ミナト生活館", box: { x: 0.2, y: 0.05, w: 0.5, h: 0.02 }, words: [w("ミナト生活館", 0.2, 0.05)] },
    { text: "雪解けの水 2L ¥472", box: { x: 0.1, y: 0.3, w: 0.8, h: 0.02 }, words: [w("雪解けの水", 0.1, 0.3), w("2L", 0.4, 0.3), w("¥472", 0.8, 0.3)] },
    { text: "会員番号 3216 2141", box: { x: 0.1, y: 0.8, w: 0.8, h: 0.02 }, words: [w("会員番号", 0.1, 0.8), w("3216", 0.5, 0.8), w("2141", 0.65, 0.8)] },
    ...["北空店", "空川県北空市", "レジ"].map((t, i) => ({ text: t, box: { x: 0.2, y: 0.06 + i / 100, w: 0.5, h: 0.01 }, words: [w(t, 0.2, 0.06 + i / 100)] })),
  ];
  const engine = (): OcrEngine & { calls: string[][] } => {
    const e = { calls: [] as string[][], recognize: async (_: Uint8Array, l: string[]) => (e.calls.push(l), lines), close: async () => {} };
    return e;
  };
  const answer = "RECEIPT: merchant=ミナト生活館; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good\nLINE: no=1; qty=4; unit=118; amount=472; text=雪解けの水 2L\nPII: kind=member_id; text=会員番号 3216 2141\nPII: kind=name; text=nobody here";

  it("OCRs the prepared photo, structures the text with the model, places personal data and maps boxes to the photo", async () => {
    const { client, cap, sent } = scripted(["• 2L ¥472", "• 2L ¥472", answer]);
    const e = engine();
    const reader = new OcrNovaReader({ client, cap, engine: e });
    const out = await reader.read(image("hero", "hero-ja-01"), hint);
    expect(e.calls).toEqual([["ja", "en"]]);
    expect(sent).toHaveLength(3); // the numbers of two tiles, then the text
    expect(sent[0].input.messages?.[0].content?.some((b) => b.image)).toBe(true);
    expect(textOf(sent[2])).toContain("雪解けの水 2L ¥472");
    expect(sent[2].input.messages?.[0].content?.some((b) => b.image)).toBe(false); // text only
    expect(out.receipt.lines).toHaveLength(1);
    expect(out.receipt.pii.map((p) => [p.kind, p.bbox !== null])).toEqual([["member_id", true], ["name", false]]);
    const b = out.receipt.pii[0].bbox!;
    expect(b.x + b.w).toBeLessThanOrEqual(1);
    expect(out.usage.tokensIn).toBe(300);
  });

  it("carries the cost of every call when the structured answer is refused", async () => {
    const { client, cap } = scripted(["¥472", "¥472", "RECEIPT: merchant=X; readability=good"]);
    const err = await new OcrNovaReader({ client, cap, engine: engine() }).read(image("hero", "hero-ja-01"), hint).catch((e) => e);
    expect(err.message).toMatch(/currency|totalMinor/);
    expect(err.usage.tokensIn).toBe(300);
  });

  it("a page OCR cannot read is unreadable, at no cost", async () => {
    const { client, cap, sent } = scripted([]);
    const e: OcrEngine = { recognize: async () => lines.slice(0, 3), close: async () => {} };
    const out = await new OcrNovaReader({ client, cap, engine: e }).read(image("hero", "hero-ja-01"), hint);
    expect(out.receipt.readability).toBe("unreadable");
    expect(out.usage).toMatchObject({ tokensIn: 0, usdActual: 0 });
    expect(sent).toHaveLength(0);
  });

  it("sends only the photo down to the total: the tiles end above the card rows", async () => {
    const withTotal: OcrLine[] = [...lines.slice(3), ...lines.slice(0, 2), { text: "合計 ¥472", box: { x: 0.1, y: 0.5, w: 0.8, h: 0.02 }, words: [w("合計", 0.1, 0.5), w("¥472", 0.8, 0.5)] }, lines[2], lines[2]];
    const e: OcrEngine = { recognize: async () => withTotal, close: async () => {} };
    const { client, cap, sent } = scripted(["¥472", answer]);
    await new OcrNovaReader({ client, cap, engine: e }).read(image("hero", "hero-ja-01"), hint);
    expect(sent).toHaveLength(2); // half the paper is short enough for one tile
  });

  it("with no copy of the numbers the date is left to a person, and personal data comes from the rows", async () => {
    const withCard: OcrLine[] = [
      ...lines.slice(3),
      ...lines.slice(0, 2),
      { text: "合計 ¥472", box: { x: 0.1, y: 0.5, w: 0.8, h: 0.02 }, words: [w("合計", 0.1, 0.5), w("¥472", 0.8, 0.5)] },
      lines[2],
      { text: "クレジット abc 9591", box: { x: 0.1, y: 0.6, w: 0.8, h: 0.02 }, words: [w("クレジット", 0.1, 0.6), w("abc", 0.6, 0.6), w("9591", 0.8, 0.6)] },
      { text: "ご来店ありがとうございました", box: { x: 0.1, y: 0.7, w: 0.8, h: 0.02 }, words: [w("ご来店ありがとうございました", 0.1, 0.7)] },
    ];
    const e: OcrEngine = { recognize: async () => withCard, close: async () => {} };
    const sent: ConverseCommand[] = [];
    const filtered = { ...reply(""), stopReason: "content_filtered" } as ConverseCommandOutput;
    const client: ConverseClient = { send: async (c) => (sent.push(c), sent.length === 1 ? filtered : reply(answer)) };
    const cap = new SpendCap(new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "ms-")), "l.jsonl")));
    const out = await new OcrNovaReader({ client, cap, engine: e }).read(image("hero", "hero-ja-01"), hint);
    expect(out.receipt.purchasedAt).toBeNull();
    expect(out.receipt.pii.map((p) => p.kind).sort()).toEqual(["card_number", "member_id", "name"]);
    expect(out.receipt.pii.every((p) => p.kind === "name" || p.bbox !== null)).toBe(true);
  });

  it("takes the numbers from a cheaper model when told to", async () => {
    const { client, cap, sent } = scripted(["¥472", "¥472", answer]);
    await new OcrNovaReader({ client, cap, engine: engine(), modelId: "amazon.nova-pro-v1:0", numbersModelId: "amazon.nova-lite-v1:0" }).read(image("hero", "hero-ja-01"), hint);
    expect(sent.map((c) => c.input.modelId)).toEqual(["amazon.nova-lite-v1:0", "amazon.nova-lite-v1:0", "amazon.nova-pro-v1:0"]);
  });
});

describe("OCR with Tesseract on the benchmark photos", () => {
  it("reads the hero receipt with the vendored traineddata and no system binary, and the member id box maps back onto the photo", async () => {
    const engine = new TesseractEngine(path.resolve(__dirname, "../../vendor/tessdata"));
    try {
      const t = truth("hero", "hero-ja-01");
      const prepared = prepImage(image("hero", "hero-ja-01"), { scale: 1.5 });
      const lines = await engine.recognize(prepared.png(), ["ja", "en"]);
      const all = lines.map((l) => l.text).join("\n");
      expect(all).toContain("ミナト生活館");
      expect(all).toContain("¥14,646");
      const want = t.receipt.pii.find((p) => p.kind === "member_id")!;
      const found = locateText(lines, want.text)!;
      expect(found).not.toBeNull();
      expect(iou(prepared.toOriginal(found), want.bbox!)).toBeGreaterThan(0.4);
    } finally {
      await engine.close();
    }
  }, 60_000);
});

describe("TwoPassReader", () => {
  const tile1 = "ミナト生活館\n雪解けの水 2L ¥472\nミネラル ¥216\nPII: kind=card_number; box=0.5,0.8,0.3,0.02; text=************9591";
  const tile2 = "ミネラル ¥216\n単3 ばら ¥980\n合計 ¥1,668\nPII: kind=member_id; box=0.5,0.1,0.3,0.02; text=3216 2141 5525\nPII: kind=card_number; text=************9591";
  const structured = "RECEIPT: merchant=ミナト生活館; currency=JPY; total=1668; readability=good\nLINE: amount=472; text=雪解けの水 2L\nLINE: amount=216; text=ミネラル\nLINE: amount=980; text=単3 ばら";

  it("parses a transcription: rows, personal data with boxes, fences and blanks ignored", () => {
    const t = parseTranscription("```\nrow one  \n\nPII: kind=name; box=0.1,0.2,0.3,0.4; text=A B\nPII: kind=phone; text=555\nPII: nothing\nrow two\n```");
    expect(t.rows).toEqual(["row one", "row two"]);
    expect(t.pii).toEqual([{ kind: "name", text: "A B", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }, { kind: "phone", text: "555", box: null }]);
  });

  it("transcribes each tile, drops the shared rows, structures the merged text and maps personal data to the photo", async () => {
    const { client, cap, sent } = scripted([tile1, tile2, structured]);
    const out = await new TwoPassReader({ client, cap }).read(image("hero", "hero-ja-01"), hint);
    expect(sent).toHaveLength(3);
    expect(sent[0].input.messages?.[0].content?.find((b) => b.image)?.image?.format).toBe("jpeg");
    expect(sent[2].input.messages?.[0].content?.some((b) => b.image)).toBe(false);
    const merged = textOf(sent[2]);
    expect(merged.match(/ミネラル ¥216/g)).toHaveLength(1);
    expect(merged).toContain("合計 ¥1,668");
    expect(out.receipt.lines.map((l) => l.amountMinor)).toEqual([472, 216, 980]);
    // Two card rows with the same text are one piece of personal data; boxes land inside the photo.
    expect(out.receipt.pii.map((p) => p.kind)).toEqual(["card_number", "member_id"]);
    for (const p of out.receipt.pii) expect(p.bbox!.x + p.bbox!.w).toBeLessThanOrEqual(1);
    // The member id sits in the second tile at 0.1: lower on the photo than the card row in the first at 0.8 of tile one? No: the order on the photo decides.
    expect(out.receipt.pii[1].bbox!.y).toBeGreaterThan(out.receipt.pii[0].bbox!.y);
    expect(out.usage.tokensIn).toBe(300);
  });

  it("charges the calls already made when a later step fails", async () => {
    const { client, cap } = scripted([tile1, tile2, "I cannot do that."]);
    const err = await new TwoPassReader({ client, cap }).read(image("hero", "hero-ja-01"), hint).catch((e) => e);
    expect(err.message).toMatch(/no RECEIPT row/);
    expect(err.usage.tokensIn).toBe(300);
  });

  it("refuses a cut-off transcription", async () => {
    const sent: ConverseCommand[] = [];
    const client: ConverseClient = { send: async (c) => (sent.push(c), { ...reply("rows"), stopReason: "max_tokens" } as ConverseCommandOutput) };
    const cap = new SpendCap(new JsonlSpendLedger(path.join(mkdtempSync(path.join(tmpdir(), "ms-")), "l.jsonl")));
    await expect(new TwoPassReader({ client, cap }).read(image("v1", "v1-en-01"), { currency: "USD", languages: ["en"] })).rejects.toThrow(/cut off/);
    expect(sent).toHaveLength(1);
  });
});

describe("dates and totals from the printed rows", () => {
  const rows = (...t: string[]) => t.map((text) => ({ text }));

  it("reads the date in each format, day first outside the US", () => {
    expect(printedDate(["2026 年 11 月 05 日 ( 木 ) 14:32"], ["ja", "en"])).toBe("2026-11-05T14:32:00");
    expect(printedDate(["05/11/2026 10:09 CAJA 03"], ["es", "en"])).toBe("2026-11-05T10:09:00");
    expect(printedDate(["TARİH: 06.11.2026 14:36 FİŞ NO: 9824"], ["tr", "en"])).toBe("2026-11-06T14:36:00");
    expect(printedDate(["11/04/2026 03:58 PM REG 05"], ["en"])).toBe("2026-11-04T15:58:00");
    expect(printedDate(["11/04/2026 12:05 AM"], ["en"])).toBe("2026-11-04T00:05:00");
    expect(printedDate(["13/04/2026 10:00"], ["en"])).toBe("2026-04-13T10:00:00"); // 13 cannot be the month
  });

  it("finds no date where there is none or it cannot be real", () => {
    expect(printedDate(["TEL 0123-45-6789", "2026 年 13 月 95 日"], ["ja"])).toBeNull();
    expect(printedDate([], ["en"])).toBeNull();
    expect(printedDate(["31/02/2026"], ["es"])).toBeNull();
  });

  const lines = [{ rawText: "AA", amountMinor: 1000, lineNo: 1 }, { rawText: "BB", amountMinor: 500, lineNo: 2 }];
  const obj = { currency: "JPY", lines, subtotalMinor: 9, taxMinor: 7, taxIncluded: true, totalMinor: 3 };

  it("tax inside: the total row decides, and a subtotal row is kept when it agrees", () => {
    const out = groundReceipt(obj, rows("AA ¥1,000", "BB ¥500", "小計 ¥1,500", "合計 ¥1,500", "お支払い ¥1,500"));
    expect(out).toMatchObject({ totalMinor: 1500, subtotalMinor: 1500, taxMinor: 7, taxIncluded: true });
  });

  it("tax on top: believed when the printed tax rows close the gap", () => {
    const out = groundReceipt(obj, rows("AA ¥1,000", "BB ¥500", "小計 ¥1,500", "外税 8% 対象 ¥1,000 消費税 ¥80", "外税 10% 対象 ¥500 消費税 ¥50", "合計 ¥1,630"));
    expect(out).toMatchObject({ totalMinor: 1630, taxMinor: 130, taxIncluded: false, subtotalMinor: 1500 });
  });

  it("a misread total: the payment row that the lines add up to wins; a misread subtotal is dropped", () => {
    expect(groundReceipt(obj, rows("AA ¥1,000", "BB ¥500", "小計 ¥1,590", "合計 ¥1,599", "お支払い ¥1,500"))).toMatchObject({ totalMinor: 1500, subtotalMinor: null });
  });

  it("forgets a translation made from a garbled row", () => {
    const out = groundReceipt({ currency: "JPY", lines: [{ rawText: "ベビーラプ", amountMinor: 1098, translationEn: "Baby lap", lineNo: 1 }] }, [{ text: "ベビーラプがッツ M ¥1,098", reread: true }, { text: "合計 ¥1,098" }]);
    expect(out.lines).toMatchObject([{ rawText: "ベビーラプがッツ M", translationEn: "" }]);
  });

  it("does not take a store or register number for an amount", () => {
    const out = groundReceipt({ currency: "USD", lines: [{ rawText: "AA BATTERY", amountMinor: 799, lineNo: 1 }] }, rows("CORNER PHARMACY #14", "Brindlewood, NY 12345", "TRANS #2718", "AA BATTERY $7.99 T", "SUBTOTAL $7.99", "TOTAL $7.99"));
    expect((out.lines as { rawText: string }[]).map((l) => l.rawText)).toEqual(["AA BATTERY"]);
    expect(out.totalMinor).toBe(799);
  });

  it("when nothing adds up the total row stands, so the check flags it", () => {
    expect(groundReceipt(obj, rows("AA ¥1,000", "BB ¥500", "小計 ¥1,700", "合計 ¥1,700", "お支払い ¥1,700"))).toMatchObject({ totalMinor: 1700, subtotalMinor: 1700 });
  });
});
