import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockNovaClassifier, BedrockNovaReader, ModelOutputError, NOVA_MODELS, minorUnits, type ConverseClient } from "../../src/receipts/bedrock";
import { RecordedClassifier, RecordedReader, receiptKey } from "../../src/receipts/recorded";
import { sha256Hex } from "../../src/receipts/hash";
import { JsonlSpendLedger, SpendCap, SpendCapExceeded } from "../../src/receipts/spend";
import { cls, needs, receipt } from "./fixtures";
import type { LineClassification, ParsedReceipt } from "../../src/receipts/types";

const kvs = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join("; ");
/** The receipt as the reader model answers: plain text, one row per line. */
function answer(r: ParsedReceipt): string {
  return [
    `RECEIPT: ${kvs({ merchant: r.merchantName, address: r.merchantAddress, country: r.country, currency: r.currency, purchased: r.purchasedAt, number: r.receiptNumber, subtotal: r.subtotalMinor, tax: r.taxMinor, tax_included: r.taxIncluded, total: r.totalMinor, readability: r.readability })}`,
    ...r.lines.map((l) => `LINE: ${kvs({ no: l.lineNo, qty: l.qty, unit: l.unitPriceMinor, amount: l.amountMinor, rate: l.taxRateBp, text: l.rawText, en: l.translationEn })}`),
    ...r.pii.map((p) => `PII: ${kvs({ kind: p.kind, box: p.bbox ? [p.bbox.x, p.bbox.y, p.bbox.w, p.bbox.h].join(",") : null, text: p.text })}`),
  ].join("\n");
}
const say = (t: string) => reply([{ text: t }], { stopReason: "end_turn" });
const wireCls = (ls: LineClassification[]) => ({ lines: ls.map((l) => kvs({ no: l.lineNo, need: l.needId, qty: l.needQty, verdict: l.verdict, rule: l.ruleCode, conf: l.confidence, why: l.reasonEn })).join("\n") });

const IMG = { bytes: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" as const };
const hint = { currency: "JPY" as const, languages: ["ja"] };

function reply(content: unknown[], extra: Partial<ConverseCommandOutput> = {}): ConverseCommandOutput {
  return {
    output: { message: { role: "assistant", content } },
    stopReason: "tool_use",
    usage: { inputTokens: 1800, outputTokens: 400, totalTokens: 2200 },
    metrics: { latencyMs: 1 },
    $metadata: {},
    ...extra,
  } as ConverseCommandOutput;
}
const toolUse = (name: string, input: unknown) => ({ toolUse: { toolUseId: "t1", name, input } });

async function setup(response: ConverseCommandOutput, maxUsd = 5) {
  const send = vi.fn<(c: ConverseCommand) => Promise<ConverseCommandOutput>>(async () => response);
  const client: ConverseClient = { send };
  const ledger = new JsonlSpendLedger(path.join(await mkdtemp(path.join(tmpdir(), "bedrock-")), "l.jsonl"));
  return { client, send, ledger, cap: new SpendCap(ledger, maxUsd) };
}

describe("BedrockNovaReader", () => {
  const r = receipt({ pii: [{ kind: "card_number", text: "************1234", bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } }, { kind: "name", text: "A B", bbox: null }], subtotalMinor: 1500 });

  it("sends the image as plain text request in-Region and returns the parsed receipt with usage", async () => {
    const { client, send, cap, ledger } = await setup(say(answer(r)));
    const out = await new BedrockNovaReader({ client, cap }).read(IMG, hint);
    expect(out.receipt).toEqual(r);
    expect(out.usage).toMatchObject({ model: NOVA_MODELS.lite, tokensIn: 1800, tokensOut: 400 });
    expect(out.usage.usdActual).toBeCloseTo((1800 * 0.06 + 400 * 0.24) / 1e6, 8);
    expect(out.usage.usdCeiling).toBeGreaterThan(out.usage.usdActual!);
    expect(await ledger.total()).toBeCloseTo(out.usage.usdActual!, 6);

    const input = send.mock.calls[0][0].input;
    expect(input.modelId).toBe("amazon.nova-lite-v1:0");
    expect(input.modelId).not.toMatch(/^us\./);
    expect(input.toolConfig).toBeUndefined(); // no tool: Nova breaks tool calls on Japanese text
    const blocks = input.messages?.[0].content ?? [];
    expect(blocks.find((b) => b.image)?.image).toMatchObject({ format: "png", source: { bytes: IMG.bytes } });
    expect(blocks.find((b) => b.text)?.text).toContain("JPY");
    expect(input.inferenceConfig?.temperature).toBe(0);
    expect(input.system?.[0].text).toContain("RECEIPT:");
  });

  it("maps jpeg media type and honours the model override", async () => {
    const { client, send, cap } = await setup(say(answer(receipt())));
    await new BedrockNovaReader({ client, cap, modelId: NOVA_MODELS.pro }).read({ ...IMG, mediaType: "image/jpeg" }, hint);
    const input = send.mock.calls[0][0].input;
    expect(input.modelId).toBe("amazon.nova-pro-v1:0");
    expect(input.messages?.[0].content?.find((b) => b.image)?.image?.format).toBe("jpeg");
  });

  it("reads the model's habits: chatter and code fences around the rows, bullets, null spelled out, amounts with symbols, decimals, odd key order and case", async () => {
    const text = [
      "Here is the receipt:",
      "```",
      "RECEIPT: merchant=Corner Shop; currency=usd; purchased=2026-11-04T15:58:00; total=$51.41; subtotal=49.18; tax=2.23; tax_included=false; readability=Good; country=null",
      "- LINE: no=1; qty=6; unit=1.49; amount=8.94; rate=null; text=SPRING WATER 1GAL; en=Spring water",
      "LINE: amount: -1,20; text=COUPON; en=Coupon; no=2",
      "LINE: text=SUBTOTAL; en=Subtotal; amount=null",
      "line: no=9; amount=799; text=AA 8PK; ok; en=AA batteries; rate=725",
      "PII: kind=card; box=0.1,0.2,0.3,0.04; text=****1234",
      "PII: (illegible)",
      "PII: kind=name; text=null",
      "```",
    ].join("\n");
    const { client, cap } = await setup(say(text));
    const out = (await new BedrockNovaReader({ client, cap }).read(IMG, hint)).receipt;
    expect(out).toMatchObject({ merchantName: "Corner Shop", currency: "USD", totalMinor: 5141, subtotalMinor: 4918, taxMinor: 223, taxIncluded: false, readability: "good", country: null, merchantAddress: null });
    expect(out.lines).toEqual([
      { lineNo: 1, qty: 6, unitPriceMinor: 149, amountMinor: 894, taxRateBp: null, rawText: "SPRING WATER 1GAL", translationEn: "Spring water" },
      { lineNo: 2, qty: null, unitPriceMinor: null, amountMinor: -120, taxRateBp: null, rawText: "COUPON", translationEn: "Coupon" },
      { lineNo: 3, qty: null, unitPriceMinor: null, amountMinor: 799, taxRateBp: 725, rawText: "AA 8PK; ok", translationEn: "AA batteries" },
    ]);
    expect(out.pii).toEqual([{ kind: "other", bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, text: "****1234" }]);
  });

  it("converts amounts by the printed currency: yen are whole, thousands separators go, other currencies take decimals", () => {
    expect(minorUnits("¥1,298", 0)).toBe(1298);
    expect(minorUnits("1.298", 0)).toBe(1298);
    expect(minorUnits("798", 0)).toBe(798);
    expect(minorUnits("1.49", 0)).toBe(1.49); // not an integer yen: left for the schema to refuse
    expect(minorUnits("x1", 2)).toBe("x1"); // letters are not symbols to drop
    expect(minorUnits("1.234,50", 2)).toBe(123450);
    expect(minorUnits("-0,06", 2)).toBe(-6);
    expect(minorUnits("€ 12.50", 2)).toBe(1250);
    expect(minorUnits("1250", 2)).toBe(1250);
    expect(minorUnits("7.7", 2)).toBe(770);
    expect(minorUnits("1,298", 2)).toBe("1,298"); // thousands or decimals? not guessed
    expect(minorUnits("abc", 2)).toBe("abc");
    expect(minorUnits("-", 2)).toBeNull();
    expect(minorUnits(undefined, 2)).toBeNull();
  });

  it("still refuses what the full schema refuses, and says what the call cost", async () => {
    const bad = [
      ["RECEIPT: currency=JPY; total=100; readability=good\nLINE: no=1; amount=x1; text=a; en=b", /lines\.0\.amountMinor|amountMinor/],
      ["RECEIPT: merchant=X; total=100; readability=good", /currency/],
      ["RECEIPT: merchant=X; currency=JPY; readability=good", /totalMinor/],
      ["RECEIPT: merchant=X; currency=JPY; total=100; readability=fine", /readability/],
      ["RECEIPT: merchant=X; currency=JPY; total=1.5; readability=good", /totalMinor/],
    ] as const;
    for (const [t, why] of bad) {
      const { client, cap } = await setup(say(t));
      const err = await new BedrockNovaReader({ client, cap }).read(IMG, hint).catch((e) => e);
      expect(err, t).toBeInstanceOf(ModelOutputError);
      expect(err.message).toMatch(why);
      expect(err.usage.tokensIn).toBe(1800);
      expect(err.raw).toBe(t);
    }
  });

  it("refuses an answer without a RECEIPT row, or one that was cut off", async () => {
    const a = await setup(say("Sorry, I cannot read this."));
    await expect(new BedrockNovaReader({ client: a.client, cap: a.cap }).read(IMG, hint)).rejects.toThrow(/no RECEIPT row/);
    const b = await setup(reply([{ text: answer(receipt()) }], { stopReason: "max_tokens" }));
    await expect(new BedrockNovaReader({ client: b.client, cap: b.cap }).read(IMG, hint)).rejects.toThrow(/cut off.*max_tokens/);
  });

  it("tries once more after the model's own broken call, and no more than once", async () => {
    const broken = Object.assign(new Error("invalid sequence"), { name: "ModelErrorException" });
    const ok = say(answer(receipt()));
    const a = await setup(ok);
    let n = 0;
    a.client.send = async () => { n++; if (n === 1) throw broken; return ok; };
    expect((await new BedrockNovaReader({ client: a.client, cap: a.cap }).read(IMG, hint)).receipt.merchantName).toBe("Test Store");
    expect(n).toBe(2);
    const b = await setup(ok);
    n = 0;
    b.client.send = async () => { n++; throw broken; };
    await expect(new BedrockNovaReader({ client: b.client, cap: b.cap }).read(IMG, hint)).rejects.toThrow("invalid sequence");
    expect(n).toBe(2);
    n = 0;
    const c = await setup(ok);
    c.client.send = async () => { n++; throw new Error("ThrottlingException"); };
    await expect(new BedrockNovaReader({ client: c.client, cap: c.cap }).read(IMG, hint)).rejects.toThrow("Throttling");
    expect(n).toBe(1);
  });

  it("does not send anything when the cap would be passed", async () => {
    const { client, send, cap } = await setup(say(answer(receipt())), 0.001);
    await expect(new BedrockNovaReader({ client, cap }).read(IMG, hint)).rejects.toThrow(SpendCapExceeded);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets a client error through and keeps the reservation", async () => {
    const { cap, ledger } = await setup(reply([]));
    const client: ConverseClient = { send: async () => { throw new Error("AccessDenied"); } };
    await expect(new BedrockNovaReader({ client, cap }).read(IMG, hint)).rejects.toThrow("AccessDenied");
    expect(await ledger.total()).toBeGreaterThan(0);
  });
});

describe("BedrockNovaClassifier", () => {
  it("sends drive rules, needs and lines as text and returns the classifications", async () => {
    const lines = [cls(1, { needQty: 6 }), cls(2, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol" })];
    const { client, send, cap } = await setup(reply([toolUse("submit_classifications", wireCls(lines))]));
    const out = await new BedrockNovaClassifier({ client, cap }).classify({ receipt: receipt(), needs, rules: "No alcohol." });
    expect(out.lines).toEqual(lines);
    expect(out.usage.model).toBe(NOVA_MODELS.pro);
    const input = send.mock.calls[0][0].input;
    expect(input.modelId).toBe("amazon.nova-pro-v1:0");
    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: "submit_classifications" } });
    const text = input.messages?.[0].content?.[0].text ?? "";
    expect(text).toContain("No alcohol.");
    expect(text).toContain('"id":"water"');
    expect(text).toContain("item 1");
    expect(input.messages?.[0].content?.some((b) => b.image)).toBe(false);
  });

  it("reads every row when the model writes a literal backslash-n or runs the rows together with semicolons", async () => {
    for (const glue of ["\\n", "; "]) {
      const text = ["no=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Water.", "no=2; verdict=rejected; rule=alcohol; conf=0.9; why=Beer."].join(glue);
      const { client, cap } = await setup(reply([toolUse("submit_classifications", { lines: text })]));
      const out = await new BedrockNovaClassifier({ client, cap }).classify({ receipt: receipt(), needs, rules: "" });
      expect(out.lines.map((l) => [l.lineNo, l.verdict])).toEqual([[1, "eligible"], [2, "rejected"]]);
    }
  });

  it("accepts tool input delivered as a JSON string, one text row per line, tolerant of key case and order", async () => {
    const text = "NO=1; need=water; qty=6; verdict=eligible; conf=0.95; why=Water; fine\n\nverdict=rejected; no=2; rule=alcohol; conf=0.9; why=Beer.";
    const { client, cap } = await setup(reply([toolUse("submit_classifications", JSON.stringify({ lines: text }))]));
    const out = await new BedrockNovaClassifier({ client, cap }).classify({ receipt: receipt(), needs, rules: "" });
    expect(out.lines).toEqual([
      { lineNo: 1, needId: "water", needQty: 6, verdict: "eligible", ruleCode: null, confidence: 0.95, reasonEn: "Water; fine" },
      { lineNo: 2, needId: null, needQty: null, verdict: "rejected", ruleCode: "alcohol", confidence: 0.9, reasonEn: "Beer." },
    ]);
  });

  it("refuses an empty answer, and a row with no fields", async () => {
    for (const lines of ["", "just words"]) {
      const { client, cap } = await setup(reply([toolUse("submit_classifications", { lines })]));
      await expect(new BedrockNovaClassifier({ client, cap }).classify({ receipt: receipt(), needs, rules: "" })).rejects.toThrow(ModelOutputError);
    }
  });

  it("refuses a classification that breaks the schema", async () => {
    const bad = [{ ...cls(1), confidence: 3 }];
    const { client, cap } = await setup(reply([toolUse("submit_classifications", wireCls(bad))]));
    await expect(new BedrockNovaClassifier({ client, cap }).classify({ receipt: receipt(), needs, rules: "" })).rejects.toThrow(ModelOutputError);
  });
});

describe("recorded reader and classifier", () => {
  it("replays by image hash and receipt key at no cost", async () => {
    const r = receipt();
    const lines = [cls(1)];
    const reader = new RecordedReader({ readings: { [sha256Hex(IMG.bytes)]: r } });
    const got = await reader.read(IMG, hint);
    expect(got.receipt).toEqual(r);
    expect(got.receipt).not.toBe(r);
    expect(got.usage).toMatchObject({ model: "recorded", usdCeiling: 0, usdActual: 0 });
    const classifier = new RecordedClassifier({ classifications: { [receiptKey(r)]: lines } });
    expect((await classifier.classify({ receipt: got.receipt, needs, rules: "" })).lines).toEqual(lines);
  });

  it("fails loudly when nothing was recorded", async () => {
    await expect(new RecordedReader({ readings: {} }).read(IMG, hint)).rejects.toThrow(/no recorded reading/);
    await expect(new RecordedClassifier({ classifications: {} }).classify({ receipt: receipt(), needs, rules: "" })).rejects.toThrow(/no recorded classification/);
  });

  it("receiptKey ignores key order but not content", () => {
    const a = receipt();
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(receiptKey(b)).toBe(receiptKey(a));
    expect(receiptKey({ ...a, totalMinor: a.totalMinor + 1 })).not.toBe(receiptKey(a));
  });
});
