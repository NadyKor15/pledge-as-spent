import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseClient } from "../../src/receipts/bedrock";
import { OcrNovaReader, TesseractEngine, groundNumbers, locateText, tesseractLanguages, tidyOcrText, type OcrEngine, type OcrLine } from "../../src/receipts/ocr";
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
    // A quantity of 0 is replaced by amount / unit price when that divides evenly (2397 / 799 = 3).
    expect(out.map((l) => [l.unitPriceMinor, l.qty])).toEqual([[null, 8], [799, 3]]);
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
  ];
  const engine = (): OcrEngine & { calls: string[][] } => {
    const e = { calls: [] as string[][], recognize: async (_: Uint8Array, l: string[]) => (e.calls.push(l), lines), close: async () => {} };
    return e;
  };
  const answer = "RECEIPT: merchant=ミナト生活館; currency=JPY; purchased=2026-11-05T14:32:00; total=472; readability=good\nLINE: no=1; qty=4; unit=118; amount=472; text=雪解けの水 2L\nPII: kind=member_id; text=会員番号 3216 2141\nPII: kind=name; text=nobody here";

  it("OCRs the prepared photo, structures the text with the model, places personal data and maps boxes to the photo", async () => {
    const { client, cap, sent } = scripted([answer]);
    const e = engine();
    const reader = new OcrNovaReader({ client, cap, engine: e });
    const out = await reader.read(image("hero", "hero-ja-01"), hint);
    expect(e.calls).toEqual([["ja", "en"]]);
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0])).toContain("雪解けの水 2L ¥472");
    expect(sent[0].input.messages?.[0].content?.some((b) => b.image)).toBe(false); // text only
    expect(out.receipt.lines).toHaveLength(1);
    expect(out.receipt.pii.map((p) => [p.kind, p.bbox !== null])).toEqual([["member_id", true], ["name", false]]);
    const b = out.receipt.pii[0].bbox!;
    expect(b.x + b.w).toBeLessThanOrEqual(1);
    expect(out.usage.tokensIn).toBe(100);
  });

  it("carries the cost of the call when the structured answer is refused", async () => {
    const { client, cap } = scripted(["RECEIPT: merchant=X; readability=good"]);
    const err = await new OcrNovaReader({ client, cap, engine: engine() }).read(image("hero", "hero-ja-01"), hint).catch((e) => e);
    expect(err.message).toMatch(/currency|totalMinor/);
    expect(err.usage.tokensIn).toBe(100);
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
