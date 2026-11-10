import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSpendLedger, SpendCap, SpendCapExceeded, modelUsd, worstCaseTokensIn, worstCaseUsd } from "../../src/receipts/spend";

const MODEL = "muse-spark-1.3";
const est = { textChars: 1000, toolSpecChars: 2000, images: 1, maxTokens: 4000 };
const newLedger = async () => new JsonlSpendLedger(path.join(await mkdtemp(path.join(tmpdir(), "spend-")), "ledger.jsonl"));

describe("prices", () => {
  it("prices Meta's Muse Spark per million tokens, and refuses a model it has no price for", () => {
    expect(modelUsd(MODEL, 1_000_000, 1_000_000)).toBeCloseTo(5.5, 10);
    expect(modelUsd(MODEL, 1_000_000, 0)).toBeCloseTo(1.25, 10);
    expect(() => modelUsd("muse-spark-1.3-contributor", 1, 1)).toThrow(/no price/);
  });

  it("assumes one token per character, 30 % margin, tool preamble and 3000 tokens per image", () => {
    // text 1000*1.3+100 = 1400; tool 2000*1.3+600 = 3200; image 3000
    expect(worstCaseTokensIn(est)).toBe(7600);
    expect(worstCaseTokensIn({ ...est, toolSpecChars: 0, images: 0 })).toBe(1400);
    expect(worstCaseUsd(MODEL, est)).toBeCloseTo((7600 * 1.25 + 4000 * 4.25) / 1e6, 8);
  });
});

describe("SpendCap", () => {
  it("reserves the worst case, runs, then settles to the real tokens", async () => {
    const ledger = await newLedger();
    const cap = new SpendCap(ledger);
    const out = await cap.call({ model: MODEL, what: "t", estimate: est }, async () => ({ value: "v", tokensIn: 2000, tokensOut: 300 }));
    expect(out.value).toBe("v");
    expect(out.usage.usdCeiling).toBeCloseTo(worstCaseUsd(MODEL, est), 6);
    expect(out.usage.usdActual).toBeCloseTo(modelUsd(MODEL, 2000, 300), 6);
    expect(await ledger.total()).toBeCloseTo(modelUsd(MODEL, 2000, 300), 6);
  });

  it("writes the reservation before the call is made", async () => {
    const ledger = await newLedger();
    let seen = 0;
    await new SpendCap(ledger).call({ model: MODEL, what: "t", estimate: est }, async () => {
      seen = await ledger.total();
      return { value: 1, tokensIn: 1, tokensOut: 1 };
    });
    expect(seen).toBeCloseTo(worstCaseUsd(MODEL, est), 6);
  });

  it("refuses a call that would pass the ceiling and never runs it", async () => {
    const ledger = await newLedger();
    const cap = new SpendCap(ledger, worstCaseUsd(MODEL, est) * 1.5);
    await cap.call({ model: MODEL, what: "first", estimate: est }, async () => ({ value: 1, tokensIn: 7600, tokensOut: 4000 }));
    let ran = false;
    await expect(
      cap.call({ model: MODEL, what: "second", estimate: est }, async () => {
        ran = true;
        return { value: 1, tokensIn: 0, tokensOut: 0 };
      }),
    ).rejects.toThrow(SpendCapExceeded);
    expect(ran).toBe(false);
  });

  it("keeps the whole cap across runs (cumulative ledger)", async () => {
    const ledger = await newLedger();
    const tight = worstCaseUsd(MODEL, est) * 1.2;
    await new SpendCap(ledger, tight).call({ model: MODEL, what: "run 1", estimate: est }, async () => ({ value: 1, tokensIn: 7600, tokensOut: 4000 }));
    await expect(new SpendCap(ledger, tight).call({ model: MODEL, what: "run 2", estimate: est }, async () => ({ value: 1, tokensIn: 0, tokensOut: 0 }))).rejects.toThrow(/ceiling/);
  });

  it("allows a call that lands exactly on the ceiling", async () => {
    const ledger = await newLedger();
    const cap = new SpendCap(ledger, worstCaseUsd(MODEL, est));
    await expect(cap.call({ model: MODEL, what: "t", estimate: est }, async () => ({ value: 1, tokensIn: 1, tokensOut: 1 }))).resolves.toBeTruthy();
  });

  it("keeps the reservation when the call fails", async () => {
    const ledger = await newLedger();
    await expect(new SpendCap(ledger).call({ model: MODEL, what: "t", estimate: est }, async () => { throw new Error("throttled"); })).rejects.toThrow("throttled");
    expect(await ledger.total()).toBeCloseTo(worstCaseUsd(MODEL, est), 6);
  });

  it("refuses an unpriced model before touching the ledger", async () => {
    const ledger = await newLedger();
    await expect(new SpendCap(ledger).call({ model: "x", what: "t", estimate: est }, async () => ({ value: 1, tokensIn: 0, tokensOut: 0 }))).rejects.toThrow(/no price/);
    expect(await ledger.total()).toBe(0);
  });

  it("is atomic: parallel calls never pass the ceiling", async () => {
    const ledger = await newLedger();
    const one = worstCaseUsd(MODEL, est);
    const cap = new SpendCap(ledger, one * 3.5);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => cap.call({ model: MODEL, what: `p${i}`, estimate: est }, async () => ({ value: i, tokensIn: 7600, tokensOut: 4000 }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
    expect(await ledger.total()).toBeLessThanOrEqual(one * 3.5);
  });

  it("stores one JSON object per line", async () => {
    const ledger = await newLedger();
    await new SpendCap(ledger, 5, () => new Date("2026-11-01T00:00:00Z")).call({ model: MODEL, what: "t", estimate: est }, async () => ({ value: 1, tokensIn: 10, tokensOut: 10 }));
    const file = (ledger as unknown as { file: string }).file;
    const rows = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.kind)).toEqual(["reserve", "settle"]);
    expect(rows[1].ref).toBe(rows[0].id);
    expect(rows[0].ts).toBe("2026-11-01T00:00:00.000Z");
  });
});
