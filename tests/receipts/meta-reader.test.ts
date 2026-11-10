import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addsUp, AgreeingClassifier, compareReadings, MetaRawClassifier, MetaTwoReadings, parseSecond, parseThird, READ_A_SYSTEM, READ_B_SYSTEM, RecordedRawClassifier, SECOND_OFFSET, trustedBands } from "../../src/receipts/meta-reader";
import { metaRespond, META_READ_MODEL } from "../../src/receipts/meta";
import { JsonlSpendLedger, modelUsd, PrefixJsonlSpendLedger, SpendCap, SpendCapExceeded } from "../../src/receipts/spend";
import type { LineClassification, ParsedReceipt, SecondReading } from "../../src/receipts/types";
import { SCENARIOS } from "../../tools/receipts/scenario";

// Reading by Meta's models only, twice: no test here reaches Meta. A fake fetch answers, and the spend ledger is a
// temporary file, so every rule about money (reserve before, settle after, a refusal costs nothing) is checked too.

const ROOT = path.resolve(__dirname, "../..");
const needs = SCENARIOS.ja.needs;
const ledgerFile = () => path.join(mkdtempSync(path.join(tmpdir(), "meta-read-")), "ledger.jsonl");

type Call = { url: string; body: Record<string, unknown>; auth: string | null };
function fakeMeta(answers: (string | { status: number; body: string })[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more fake answers");
    if (typeof next !== "string") return new Response(next.body, { status: next.status });
    return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: next }] }], usage: { input_tokens: 3000, output_tokens: 900 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const opts = (f: typeof fetch, file = ledgerFile(), max = 5) => ({ apiKey: "test-key", cap: new SpendCap(new PrefixJsonlSpendLedger(file, "read-meta-eval:"), max), prefix: "read-meta-eval:", fetch: f, sleep: async () => {} });

const A_ANSWER = `RECEIPT: merchant=ドラッグ ヒカリ 北空中央店; address=空川県北空市中央3-5-12; country=JP; currency=JPY; purchased=2026-11-08T10:13:00; number=7283; subtotal=6854; tax=148; tax_included=false; total=7002; readability=good
LINE: no=1; qty=2; unit=858; amount=1716; rate=800; text=おいしい水 2L 6本入; en=Tasty water 2 L, 6 pack
LINE: no=2; qty=1; unit=5000; amount=5000; text=プリペイドカード 5,000円; en=Prepaid card
LINE: no=3; amount=138; rate=800; text=山里の湧水 2L; en=Spring water 2 L
PII: kind=card_number; box=0.57,0.64,0.23,0.03; text=************4980
PII: kind=member_id; box=0.58,0.77,0.2,0.03; text=4918 7675 3547`;

const B_ANSWER = `BAND: n=1; text=ドラッグ ヒカリ
BAND: n=2; text=北空中央店
BAND: n=3; text=おいしい水 2L ¥1,716※
BAND: n=4; text=6本入
BAND: n=5; text=2点 x 単858
BAND: n=6; text=プリペイドカード 5,000円 ¥5,000
BAND: n=7; text=山里の湧水 2L ¥138※
BAND: n=8; text=合計 ¥7,002
BAND: n=9; text=会員番号 4918 7675 3547
RECEIPT: merchant=ドラッグ ヒカリ 北空中央店; address=空川県北空市中央3-5-12; currency=JPY; purchased=2026-11-08T10:13:00; total=7002; readability=good
LINE: no=1; qty=2; unit=858; amount=1716; rate=800; text=おいしい水 2L 6本入; en=Tasty water 2 L; bands=3,4,5
LINE: no=2; amount=5000; text=プリペイドカード 5,000円; en=Prepaid card; bands=6
LINE: no=3; amount=138; rate=800; text=山里の湧水 2L; en=Spring water; bands=7`;

const quad = (i: number): [number, number][] => [
  [100, 100 + i * 20],
  [500, 100 + i * 20],
  [500, 118 + i * 20],
  [100, 118 + i * 20],
];
const bands = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, y0: i * 40, y1: i * 40 + 36, quad: quad(i + 1) }));

function readings() {
  const a = parseA(A_ANSWER);
  const p = parseSecond(B_ANSWER);
  const b = { ...(p.receipt as ParsedReceipt), pii: [] };
  const second: SecondReading = { receipt: b, lineBands: p.lineBands, bandTexts: p.bandTexts, bands, size: { width: 633, height: 899 }, error: null };
  return { a, second };
}
const parseA = (t: string) => ParsedReceiptOf(t);
import { receiptFromText } from "../../src/receipts/wire";
import { ParsedReceipt as PR } from "../../src/receipts/types";
const ParsedReceiptOf = (t: string) => PR.parse(receiptFromText(t));

const cls = (lineNo: number, c: Partial<LineClassification>): LineClassification => ({ lineNo, needId: null, needQty: null, verdict: "eligible", ruleCode: null, reasonEn: "x", confidence: 0.9, ...c });
const agreeing = { first: [cls(1, { needId: "water", needQty: 12 }), cls(2, { verdict: "rejected", ruleCode: "gift_card" }), cls(3, { needId: "water", needQty: 1 })] };

describe("parseSecond", () => {
  it("reads every cut's text and each line's cuts, aligned with the lines it keeps", () => {
    const p = parseSecond(B_ANSWER.replace("LINE: no=2;", "LINE: no=9; text=小計; bands=8\nLINE: no=2;"));
    expect(p.bandTexts["3"]).toBe("おいしい水 2L ¥1,716※");
    expect(p.bandTexts["9"]).toBe("会員番号 4918 7675 3547");
    // The line without an amount is dropped, and so is its entry: line 2 of the receipt keeps cut 6.
    expect(p.lineBands).toEqual([[3, 4, 5], [6], [7]]);
    const r = PR.parse({ ...(p.receipt as object), pii: [] });
    expect(r.lines.map((l) => [l.lineNo, l.amountMinor, l.rawText])).toEqual([
      [1, 1716, "おいしい水 2L 6本入"],
      [2, 5000, "プリペイドカード 5,000円"],
      [3, 138, "山里の湧水 2L"],
    ]);
    expect(r.lines[0].translationEn).toBe("Tasty water 2 L");
  });

  it("asks for the cuts in the reading-B prompt", () => {
    expect(READ_B_SYSTEM).toMatch(/BAND: n=<number>/);
    expect(READ_B_SYSTEM).toMatch(/bands=<the numbers of the cuts/);
  });
});

describe("metaRespond", () => {
  it("sends one Standard, unstored request and settles the reservation to the real token price", async () => {
    const { f, calls } = fakeMeta(["hello"]);
    const file = ledgerFile();
    const o = opts(f, file);
    const out = await metaRespond(o, { what: "probe", instructions: "Say hello.", parts: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] });
    expect(out.text).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.meta.ai/v1/responses");
    expect(calls[0].auth).toBe("Bearer test-key");
    expect(calls[0].body).toMatchObject({ model: META_READ_MODEL, store: false, stream: false, instructions: "Say hello." });
    expect(META_READ_MODEL).toBe("muse-spark-1.3");
    expect(out.usage.usdActual).toBeCloseTo(modelUsd("muse-spark-1.3", 3000, 900), 6);
    expect(await o.cap.ledger.total()).toBeCloseTo(modelUsd("muse-spark-1.3", 3000, 900), 6);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.kind)).toEqual(["reserve", "settle"]);
    expect(rows[0].what).toMatch(/^read-meta-eval:probe/);
    expect(rows[1].runningUsd).toBeCloseTo(modelUsd("muse-spark-1.3", 3000, 900), 6);
  });

  it("charges nothing for an HTTP refusal, retries a 429, and stops at the ceiling before sending", async () => {
    const { f, calls } = fakeMeta([{ status: 400, body: "bad request" }]);
    const o = opts(f);
    await expect(metaRespond(o, { what: "x", instructions: "i", parts: [{ type: "input_text", text: "t" }] })).rejects.toThrow(/400/);
    expect(await o.cap.ledger.total()).toBeCloseTo(0, 9);
    expect(calls).toHaveLength(1);

    const again = fakeMeta([{ status: 429, body: "slow down" }, "ok"]);
    const o2 = opts(again.f);
    expect((await metaRespond(o2, { what: "x", instructions: "i", parts: [{ type: "input_text", text: "t" }] })).text).toBe("ok");
    expect(again.calls).toHaveLength(2);

    const none = fakeMeta(["never"]);
    const o3 = opts(none.f, ledgerFile(), 0.001);
    await expect(metaRespond(o3, { what: "x", instructions: "i", parts: [{ type: "input_text", text: "t" }] })).rejects.toBeInstanceOf(SpendCapExceeded);
    expect(none.calls).toHaveLength(0);
  });

  it("counts only its own prefix against the ceiling of a shared ledger file", async () => {
    const file = ledgerFile();
    await new JsonlSpendLedger(file).reserve({ ts: "t", id: "a", kind: "reserve", what: "agent-dev old run", usd: 4.9 }, 100);
    const { f } = fakeMeta(["ok"]);
    const o = opts(f, file, 1);
    await metaRespond(o, { what: "x", instructions: "i", parts: [{ type: "input_text", text: "t" }] });
    expect(await o.cap.ledger.total()).toBeLessThan(0.05);
  });
});

describe("compareReadings", () => {
  const run = (raw: { first: LineClassification[]; second?: LineClassification[] }, mutate?: (r: ReturnType<typeof readings>) => void) => {
    const r = readings();
    mutate?.(r);
    return compareReadings({ receipt: r.a, second: r.second, needs, raw: { first: raw.first, second: raw.second ?? raw.first } });
  };

  it("passes a line only when both readings agree on amount, quantity and need, and opens exactly its cuts", () => {
    const { lines, agreement } = run(agreeing);
    expect(lines.map((l) => [l.lineNo, l.verdict, l.needId, l.needQty])).toEqual([
      [1, "eligible", "water", 12],
      [2, "rejected", null, null],
      [3, "eligible", "water", 1],
    ]);
    expect(agreement.held).toEqual([]);
    expect(agreement.purchaseLines).toEqual([
      { lineNo: 1, bandIndexes: [3, 4, 5] },
      { lineNo: 2, bandIndexes: [6] },
      { lineNo: 3, bandIndexes: [7] },
    ]);
    // The proof box of line 1 spans its three cuts.
    const box = agreement.lineBoxes.find((b) => b.lineNo === 1)!.box;
    expect(box.y * 899).toBeCloseTo(160, 0);
    expect((box.y + box.h) * 899).toBeCloseTo(218, 0);
  });

  it("asks a person when the quantity code derives differs between the readings", () => {
    // Reading B lost the printed quantity and unit price: code derives 6 from it, 12 from reading A. Both add up
    // (B as one case at its amount), so arithmetic cannot decide, and without a third reading a person is asked.
    const { lines, agreement } = run({ first: agreeing.first, second: agreeing.first.map((c) => (c.lineNo === 1 ? { ...c, needQty: 6 } : c)) }, (r) => {
      r.second.receipt!.lines[0] = { ...r.second.receipt!.lines[0], qty: null, unitPriceMinor: null };
    });
    expect(lines[0]).toMatchObject({ verdict: "review", ruleCode: "unclear" });
    expect(lines[0].reasonEn).toMatch(/12 for water.*6 for water/);
    expect(agreement.held.map((h) => h.lineNo)).toEqual([1]);
    expect(lines[2].verdict).toBe("eligible");
  });

  it("asks a person when the second reading has no line at that amount, or names another need", () => {
    const missing = run(agreeing, (r) => {
      r.second.receipt!.lines[2] = { ...r.second.receipt!.lines[2], amountMinor: 183 };
    });
    expect(missing.lines[2]).toMatchObject({ verdict: "review" });
    expect(missing.agreement.purchaseLines.map((p) => p.lineNo)).toEqual([1, 2]);
    const other = run({ first: agreeing.first, second: agreeing.first.map((c) => (c.lineNo === 3 ? { ...c, needId: "diapers" } : c)) });
    expect(other.lines[2].verdict).toBe("review");
  });

  it("keeps a refusal for a forbidden product even when only one reading saw it", () => {
    const { lines } = run({ first: agreeing.first.map((c) => (c.lineNo === 2 ? cls(2, { needId: "water", needQty: 1 }) : c)), second: agreeing.first });
    expect(lines[1]).toMatchObject({ verdict: "rejected", ruleCode: "gift_card" });
  });

  it("holds every eligible line when the readings disagree on the total or the date, or the second failed", () => {
    const total = run(agreeing, (r) => {
      r.second.receipt!.totalMinor = 7020;
    });
    expect(total.lines.map((l) => l.verdict)).toEqual(["review", "rejected", "review"]);
    const date = run(agreeing, (r) => {
      r.second.receipt!.purchasedAt = "2026-11-03T10:13:00";
    });
    expect(date.lines.map((l) => l.verdict)).toEqual(["review", "rejected", "review"]);
    const failed = run(agreeing, (r) => {
      r.second = { ...r.second, receipt: null, error: "timeout" };
    });
    expect(failed.lines.map((l) => l.verdict)).toEqual(["review", "rejected", "review"]);
    expect(failed.agreement.purchaseLines).toEqual([]);
  });

  it("holds the line above a discount the second reading does not confirm", () => {
    const withDiscount = A_ANSWER.replace("LINE: no=3;", "LINE: no=3; amount=-90; text=値引; en=Discount\nLINE: no=4;");
    const r = readings();
    const a = ParsedReceiptOf(withDiscount);
    const first = [agreeing.first[0], agreeing.first[1], cls(3, { verdict: "rejected", ruleCode: "not_in_needs" }), cls(4, { needId: "water", needQty: 1 })];
    const out = compareReadings({ receipt: a, second: r.second, needs, raw: { first, second: agreeing.first } });
    expect(out.lines.find((l) => l.lineNo === 2)!.verdict).toBe("rejected");
    // The discount follows line 2 (the gift card), which is refused anyway; line 4 still agrees.
    expect(out.lines.find((l) => l.lineNo === 4)!.verdict).toBe("eligible");
    const a2 = ParsedReceiptOf(A_ANSWER.replace("LINE: no=2;", "LINE: no=2; amount=-90; text=値引; en=Discount\nLINE: no=3;").replace("LINE: no=3; amount=138", "LINE: no=4; amount=138"));
    const out2 = compareReadings({ receipt: a2, second: r.second, needs, raw: { first: [agreeing.first[0], cls(2, { verdict: "rejected", ruleCode: "not_in_needs" }), cls(3, { verdict: "rejected", ruleCode: "gift_card" }), cls(4, { needId: "water", needQty: 1 })], second: agreeing.first } });
    expect(out2.lines.find((l) => l.lineNo === 1)!.verdict).toBe("review");
  });
});

describe("trustedBands", () => {
  const { second } = readings();
  it("opens only cuts the second reading named, close together, with nothing personal on them", () => {
    expect(trustedBands([3, 4, 5], second, [])).toEqual([3, 4, 5]);
    expect(trustedBands([3, 9], second, [])).toEqual([]); // too far apart
    expect(trustedBands([8, 9], second, ["4918 7675 3547"])).toEqual([]); // the member number
    expect(trustedBands([42], second, [])).toEqual([]); // no such cut
    expect(trustedBands([], second, [])).toEqual([]);
  });
});

describe("MetaTwoReadings and the agreeing classifier", () => {
  it("reads the photo twice (the whole photo, then the numbered cuts) and compares the classified lines", async () => {
    const { f, calls } = fakeMeta([A_ANSWER, B_ANSWER]);
    const file = ledgerFile();
    const o = opts(f, file);
    const image = { bytes: new Uint8Array(readFileSync(path.join(ROOT, "eval/receipts/holdout/holdout-ja-01.png"))), mediaType: "image/png" as const };
    const reader = new MetaTwoReadings({ ...o, slice: () => ({ bands, tiltDeg: 0, width: 633, height: 899, sheets: [{ bytes: new Uint8Array([1]), mediaType: "image/jpeg", first: 1, last: 9 }] }) });
    const r = await reader.read(image, { currency: "JPY", languages: ["ja", "en"] });
    expect(r.receipt.totalMinor).toBe(7002);
    expect(r.second!.receipt!.lines).toHaveLength(3);
    expect(r.second!.size).toEqual({ width: 633, height: 899 });
    const instructions = calls.map((c) => c.body.instructions as string);
    expect(instructions.some((t) => t.includes("BAND: n=<number>"))).toBe(true);
    expect(calls.every((c) => c.body.model === "muse-spark-1.3")).toBe(true);

    const answer = [...agreeing.first.map((c) => `no=${c.lineNo}; ${c.needId ? `need=${c.needId}; qty=${c.needQty}; ` : ""}verdict=${c.verdict}; ${c.ruleCode ? `rule=${c.ruleCode}; ` : ""}conf=0.9; why=ok`), ...agreeing.first.map((c) => `no=${c.lineNo + SECOND_OFFSET}; ${c.needId ? `need=${c.needId}; qty=${c.needQty}; ` : ""}verdict=${c.verdict}; ${c.ruleCode ? `rule=${c.ruleCode}; ` : ""}conf=0.9; why=ok`)].join("\n");
    const c = fakeMeta([answer]);
    const classifier = new AgreeingClassifier(new MetaRawClassifier(opts(c.f, file)));
    const out = await classifier.classify({ receipt: r.receipt, needs, rules: SCENARIOS.ja.drive.rules, second: r.second });
    expect(out.lines.map((l) => l.verdict)).toEqual(["eligible", "rejected", "eligible"]);
    expect(out.agreement!.raw.second).toHaveLength(3);
    // The ledger holds every call, each with its running total.
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.kind === "reserve")).toHaveLength(3);
  });

  it("holds every eligible line when there is no second reading at all", async () => {
    const r = readings();
    const classifier = new AgreeingClassifier(new RecordedRawClassifier(() => ({ first: agreeing.first, second: [] })));
    const out = await classifier.classify({ receipt: r.a, needs, rules: "" });
    expect(out.lines.map((l) => l.verdict)).toEqual(["review", "rejected", "review"]);
  });
});

describe("arithmetic and the third reading (a disputed quantity)", () => {
  // Reading A prints qty 2 x 858 = 1716 (12 bottles); reading B lost the qty row and says 1716 for one case (6).
  const disputed = () => {
    const r = readings();
    r.second.receipt!.lines[0] = { ...r.second.receipt!.lines[0], qty: 1, unitPriceMinor: 858 };
    return r;
  };
  const raw = { first: agreeing.first, second: agreeing.first.map((c) => (c.lineNo === 1 ? { ...c, needQty: 6 } : c)) };

  it("knows when a line adds up: quantity times unit price is the amount, exactly", () => {
    expect(addsUp({ qty: 2, unitPriceMinor: 858, amountMinor: 1716 })).toBe(true);
    expect(addsUp({ qty: 1, unitPriceMinor: 858, amountMinor: 1716 })).toBe(false);
    expect(addsUp({ qty: null, unitPriceMinor: null, amountMinor: 138 })).toBe(true);
    expect(addsUp({ qty: null, unitPriceMinor: 138, amountMinor: 138 })).toBe(true);
    expect(addsUp({ qty: 3, unitPriceMinor: null, amountMinor: 414 })).toBe(false);
    expect(addsUp({ qty: 1.5, unitPriceMinor: 100, amountMinor: 150 })).toBe(false);
  });

  it("takes the reading that adds up when the other does not, with no question", () => {
    const r = disputed();
    const out = compareReadings({ receipt: r.a, second: r.second, needs, raw });
    expect(out.lines[0]).toMatchObject({ verdict: "eligible", needId: "water", needQty: 12 });
    expect(out.asks).toEqual([]);
    expect(out.agreement.held).toEqual([]);
  });

  it("asks the third reading when both add up, and passes the line only when it agrees with one and adds up", () => {
    const r = disputed();
    // Both add up: B read 1 x 1716 (a case of 6 at 1716).
    r.second.receipt!.lines[0] = { ...r.second.receipt!.lines[0], qty: 1, unitPriceMinor: 1716 };
    const first = compareReadings({ receipt: r.a, second: r.second, needs, raw });
    expect(first.lines[0].verdict).toBe("review");
    expect(first.asks).toEqual([{ lineNo: 1, bandIndexes: [3, 4, 5], kind: "quantity" }]);
    const line = (qty: number | null, unit: number | null, amount: number, text = "おいしい水 2L 6本入") => ({ lineNo: 1, rawText: text, translationEn: "", qty, unitPriceMinor: unit, amountMinor: amount, taxRateBp: null });
    const agrees = compareReadings({ receipt: r.a, second: r.second, needs, raw: { ...raw, third: { "1": line(2, 858, 1716) } } });
    expect(agrees.lines[0]).toMatchObject({ verdict: "eligible", needQty: 12 });
    expect(agrees.agreement.held).toEqual([]);
    // A third answer that does not add up, has another amount, gives a third quantity, or failed: still a person.
    for (const t of [line(3, 858, 1716), line(2, 858, 1717), line(3, 572, 1716), null]) {
      expect(compareReadings({ receipt: r.a, second: r.second, needs, raw: { ...raw, third: { "1": t } } }).lines[0].verdict).toBe("review");
    }
  });

  it("reads a line again when the second reading has it at another amount, and passes it only on the same amount and quantity", () => {
    const r = readings();
    r.second.receipt!.lines[2] = { ...r.second.receipt!.lines[2], amountMinor: 183 };
    const both = { first: agreeing.first, second: agreeing.first };
    const first = compareReadings({ receipt: r.a, second: r.second, needs, raw: both });
    expect(first.asks).toEqual([{ lineNo: 3, bandIndexes: [7], kind: "missing" }]);
    const ok = compareReadings({ receipt: r.a, second: r.second, needs, raw: { ...both, third: { "3": { lineNo: 1, rawText: "山里の湧水 2L", translationEn: "", qty: null, unitPriceMinor: null, amountMinor: 138, taxRateBp: null } } } });
    expect(ok.lines[2]).toMatchObject({ verdict: "eligible", needQty: 1 });
    const no = compareReadings({ receipt: r.a, second: r.second, needs, raw: { ...both, third: { "3": { lineNo: 1, rawText: "山里の湧水 2L", translationEn: "", qty: null, unitPriceMinor: null, amountMinor: 183, taxRateBp: null } } } });
    expect(no.lines[2].verdict).toBe("review");
  });

  it("the agreeing classifier asks the third reader only for disputed lines, at most four, and records the answers", async () => {
    const r = disputed();
    r.second.receipt!.lines[0] = { ...r.second.receipt!.lines[0], qty: 1, unitPriceMinor: 1716 };
    const asked: number[][] = [];
    const third = {
      async readLine(_image: unknown, bands: { index: number }[]) {
        asked.push(bands.map((b) => b.index));
        return { line: { lineNo: 1, rawText: "おいしい水 2L 6本入", translationEn: "", qty: 2, unitPriceMinor: 858, amountMinor: 1716, taxRateBp: null }, usage: { model: "m", tokensIn: 1, tokensOut: 1, usdCeiling: 0.001, usdActual: 0.001 } };
      },
    };
    const classifier = new AgreeingClassifier(new RecordedRawClassifier(() => raw), third);
    const out = await classifier.classify({ receipt: r.a, needs, rules: "", second: r.second, image: { bytes: new Uint8Array([1]), mediaType: "image/png" } });
    expect(asked).toEqual([[3, 4, 5]]);
    expect(out.lines[0]).toMatchObject({ verdict: "eligible", needQty: 12 });
    expect(out.agreement!.raw.third).toEqual({ "1": expect.objectContaining({ qty: 2, amountMinor: 1716 }) });
  });

  it("parses the third reading's one line, and gives nothing for an answer without an amount", () => {
    expect(parseThird("LINE: qty=2; unit=858; amount=1716; text=おいしい水 2L; en=Water", "JPY")).toMatchObject({ qty: 2, unitPriceMinor: 858, amountMinor: 1716 });
    expect(parseThird("LINE: qty=2; unit=9,45; amount=18,90; text=PAÑAL", "EUR")).toMatchObject({ qty: 2, unitPriceMinor: 945, amountMinor: 1890 });
    expect(parseThird("LINE: text=PAÑAL", "EUR")).toBeNull();
    expect(parseThird("nothing here", "EUR")).toBeNull();
  });
});

describe("reading fixes from the first held-out run", () => {
  it("tells both readings a tax base is never the subtotal", () => {
    expect(READ_A_SYSTEM).toMatch(/MATRAH, 対象\) is never the subtotal/);
    expect(READ_B_SYSTEM).toMatch(/MATRAH, 対象\) is never the subtotal/);
  });

  it("keeps an unreadable photo as an unreadable answer, and a second reading without a currency", async () => {
    const unreadable = "RECEIPT: readability=unreadable";
    const b = B_ANSWER.replace("currency=JPY; ", "");
    // The two readings run at the same time: answer each by its prompt, not by the order the calls arrive in.
    const f = (async (_u: string, init: RequestInit) => {
      const text = String(JSON.parse(String(init.body)).instructions).includes("BAND: n=<number>") ? b : unreadable;
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const reader = new MetaTwoReadings({ ...opts(f), slice: () => ({ bands, tiltDeg: 0, width: 633, height: 899, sheets: [{ bytes: new Uint8Array([1]), mediaType: "image/jpeg", first: 1, last: 9 }] }) });
    const r = await reader.read({ bytes: new Uint8Array([1]), mediaType: "image/png" }, { currency: "JPY", languages: ["ja"] });
    expect(r.receipt).toMatchObject({ readability: "unreadable", currency: "JPY", lines: [], totalMinor: 0 });
    expect(r.second!.receipt).toMatchObject({ currency: "JPY" });
    expect(r.second!.receipt!.lines).toHaveLength(3);
  });
});

describe("code and model disagree on a quantity the name does not explain", () => {
  it("asks a person instead of letting both readings agree on code's number (an unknown pack word)", () => {
    const r = readings();
    // "単3 アルカリ 6ADET": code sees no pack size and keeps the printed 1; the model counts 6 for both readings.
    const text = "単3 アルカリ 6ADET";
    r.a.lines[2] = { ...r.a.lines[2], rawText: text, qty: 1, unitPriceMinor: 138 };
    r.second.receipt!.lines[2] = { ...r.second.receipt!.lines[2], rawText: text, qty: 1, unitPriceMinor: 138 };
    const model = [agreeing.first[0], agreeing.first[1], cls(3, { needId: "batteries", needQty: 6 })];
    const out = compareReadings({ receipt: r.a, second: r.second, needs, raw: { first: model, second: model } });
    expect(out.lines[2]).toMatchObject({ verdict: "review" });
    expect(out.lines[2].reasonEn).toMatch(/code reads 1.*model counts 6/);
    // With a pack size code knows, the two agree on code's number and the line passes.
    const known = "単3 アルカリ 6本入";
    r.a.lines[2] = { ...r.a.lines[2], rawText: known };
    r.second.receipt!.lines[2] = { ...r.second.receipt!.lines[2], rawText: known };
    expect(compareReadings({ receipt: r.a, second: r.second, needs, raw: { first: model, second: model } }).lines[2]).toMatchObject({ verdict: "eligible", needQty: 6 });
  });
});
