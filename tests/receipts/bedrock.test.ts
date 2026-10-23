import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockNovaClassifier, BedrockNovaReader, ModelOutputError, NOVA_MODELS, type ConverseClient } from "../../src/receipts/bedrock";
import { RecordedClassifier, RecordedReader, receiptKey } from "../../src/receipts/recorded";
import { sha256Hex } from "../../src/receipts/hash";
import { JsonlSpendLedger, SpendCap, SpendCapExceeded } from "../../src/receipts/spend";
import { cls, needs, receipt } from "./fixtures";

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
  const send = vi.fn(async (_c: ConverseCommand) => response);
  const client: ConverseClient = { send: send as ConverseClient["send"] };
  const ledger = new JsonlSpendLedger(path.join(await mkdtemp(path.join(tmpdir(), "bedrock-")), "l.jsonl"));
  return { client, send, ledger, cap: new SpendCap(ledger, maxUsd) };
}

describe("BedrockNovaReader", () => {
  it("sends the image with a forced tool in-Region and returns the parsed receipt with usage", async () => {
    const r = receipt();
    const { client, send, cap, ledger } = await setup(reply([toolUse("submit_receipt", r)]));
    const out = await new BedrockNovaReader({ client, cap }).read(IMG, hint);
    expect(out.receipt).toEqual(r);
    expect(out.usage).toMatchObject({ model: NOVA_MODELS.lite, tokensIn: 1800, tokensOut: 400 });
    expect(out.usage.usdActual).toBeCloseTo((1800 * 0.06 + 400 * 0.24) / 1e6, 8);
    expect(out.usage.usdCeiling).toBeGreaterThan(out.usage.usdActual!);
    expect(await ledger.total()).toBeCloseTo(out.usage.usdActual!, 6);

    const input = send.mock.calls[0][0].input;
    expect(input.modelId).toBe("amazon.nova-lite-v1:0");
    expect(input.modelId).not.toMatch(/^us\./);
    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: "submit_receipt" } });
    expect(input.toolConfig?.tools?.[0].toolSpec?.name).toBe("submit_receipt");
    const schema = input.toolConfig?.tools?.[0].toolSpec?.inputSchema?.json as { type: string; properties: Record<string, unknown>; $schema?: string };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toContain("lines");
    expect(schema.$schema).toBeUndefined();
    const blocks = input.messages?.[0].content ?? [];
    expect(blocks.find((b) => b.image)?.image).toMatchObject({ format: "png", source: { bytes: IMG.bytes } });
    expect(blocks.find((b) => b.text)?.text).toContain("JPY");
    expect(input.inferenceConfig?.temperature).toBe(0);
  });

  it("maps jpeg media type and honours the model override", async () => {
    const { client, send, cap } = await setup(reply([toolUse("submit_receipt", receipt())]));
    await new BedrockNovaReader({ client, cap, modelId: NOVA_MODELS.pro }).read({ ...IMG, mediaType: "image/jpeg" }, hint);
    const input = send.mock.calls[0][0].input;
    expect(input.modelId).toBe("amazon.nova-pro-v1:0");
    expect(input.messages?.[0].content?.find((b) => b.image)?.image?.format).toBe("jpeg");
  });

  it("accepts tool input delivered as a JSON string", async () => {
    const { client, cap } = await setup(reply([toolUse("submit_receipt", JSON.stringify(receipt()))]));
    expect((await new BedrockNovaReader({ client, cap }).read(IMG, hint)).receipt.merchantName).toBe("Test Store");
  });

  it("refuses output that does not match the schema, without inventing a receipt", async () => {
    const { client, cap, ledger } = await setup(reply([toolUse("submit_receipt", { merchantName: "X" })]));
    await expect(new BedrockNovaReader({ client, cap }).read(IMG, hint)).rejects.toThrow(ModelOutputError);
    expect(await ledger.total()).toBeGreaterThan(0); // the call was made and is paid for
  });

  it("refuses an answer without the tool call, and non-JSON tool input", async () => {
    const a = await setup(reply([{ text: "sorry" }], { stopReason: "max_tokens" }));
    await expect(new BedrockNovaReader({ client: a.client, cap: a.cap }).read(IMG, hint)).rejects.toThrow(/did not call submit_receipt.*max_tokens/);
    const b = await setup(reply([toolUse("submit_receipt", "{not json")]));
    await expect(new BedrockNovaReader({ client: b.client, cap: b.cap }).read(IMG, hint)).rejects.toThrow(/not JSON/);
  });

  it("does not send anything when the cap would be passed", async () => {
    const { client, send, cap } = await setup(reply([toolUse("submit_receipt", receipt())]), 0.001);
    await expect(new BedrockNovaReader({ client, cap }).read(IMG, hint)).rejects.toThrow(SpendCapExceeded);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets a client error through and keeps the reservation", async () => {
    const { cap, ledger } = await setup(reply([]));
    const client: ConverseClient = { send: async () => { throw new Error("ThrottlingException"); } };
    await expect(new BedrockNovaReader({ client, cap }).read(IMG, hint)).rejects.toThrow("ThrottlingException");
    expect(await ledger.total()).toBeGreaterThan(0);
  });
});

describe("BedrockNovaClassifier", () => {
  it("sends drive rules, needs and lines as text and returns the classifications", async () => {
    const lines = [cls(1, { needQty: 6 }), cls(2, { verdict: "rejected", needId: null, needQty: null, ruleCode: "alcohol" })];
    const { client, send, cap } = await setup(reply([toolUse("submit_classifications", { lines })]));
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

  it("refuses a classification that breaks the schema", async () => {
    const bad = [{ ...cls(1), confidence: 3 }];
    const { client, cap } = await setup(reply([toolUse("submit_classifications", { lines: bad })]));
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
