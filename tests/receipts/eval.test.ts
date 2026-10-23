import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RecordedClassifier, RecordedReader, Recordings } from "../../src/receipts/recorded";
import type { LineClassifier, ParsedReceipt, ReceiptReader } from "../../src/receipts/types";
import { iou, levenshtein, matchLines, similarity } from "../../tools/eval/metrics";
import { loadLiveRecordings, loadTruths, runEval, toMarkdown, type EvalResult, type SetName } from "../../tools/eval/run";
import { line } from "./fixtures";

const rec = Recordings.parse(JSON.parse(readFileSync(path.resolve(__dirname, "../../eval/receipts/recorded.json"), "utf8")));
const recordedReader = new RecordedReader(rec);
const recordedClassifier = new RecordedClassifier(rec);

async function run(set: SetName, reader: ReceiptReader = recordedReader, classifier: LineClassifier = recordedClassifier) {
  const truths = await loadTruths(set);
  const known = set === "v1" ? truths : await loadTruths("v1");
  return runEval({ readerName: "test", set, reader, classifier, truths, known });
}

/** Every scored number in a result, with its name. */
function numbers(r: EvalResult): [string, number | null][] {
  const out: [string, number | null][] = [
    ["precision", r.lines.precision], ["recall", r.lines.recall], ["f1", r.lines.f1],
    ["lineAmountExact", r.lineAmountExact.rate], ["total", r.totalExact.rate], ["date", r.dateExact.rate], ["dateTime", r.dateTimeExact.rate],
    ["merchant", r.merchant.meanSimilarity], ["merchant80", r.merchant.atLeast80.rate], ["class", r.lineClass.rate], ["needQty", r.needQty.rate],
    ["rules", r.ruleLines.rate], ["pii", r.pii.found.rate], ["piiIou", r.pii.meanIou],
  ];
  for (const [f, x] of Object.entries(r.flags)) out.push([`${f} recall`, x.recall]);
  return out;
}

describe("metric helpers", () => {
  it("levenshtein and similarity", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(similarity("ミナト生活館 北空店", "ﾐﾅﾄ生活館北空店")).toBe(1);
    expect(similarity("abcd", "abcf")).toBeCloseTo(0.75);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });

  it("matches lines by amount, nearest position first, each line once", () => {
    const t = [line(1, 100), line(2, 200), line(3, 100)];
    expect(matchLines(t, [line(1, 100), line(2, 200), line(3, 100)])).toEqual([[0, 0], [1, 1], [2, 2]]);
    // A missing first line shifts the rest by one: still all matched by amount.
    expect(matchLines(t, [line(1, 200), line(2, 100)])).toEqual([[0, 1], [1, 0]]);
    // Two predicted lines with the same amount: the one nearest to the truth position wins.
    expect(matchLines([line(1, 200), line(2, 100)], [line(1, 100), line(2, 100)])).toEqual([[1, 1]]);
    expect(matchLines([line(1, 100)], [line(1, 101)])).toEqual([]);
    expect(matchLines([line(1, 100), line(2, 100)], [line(1, 100)])).toEqual([[0, 0]]);
  });

  it("box overlap", () => {
    const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
    expect(iou(a, { x: 0.2, y: 0.1, w: 0.2, h: 0.1 })).toBeCloseTo(1 / 3);
  });
});

describe("the benchmark scores the recorded reader at 100 %", () => {
  for (const set of ["v1", "adversarial", "hero"] as const) {
    it(set, async () => {
      const r = await run(set);
      expect(r.errors).toEqual([]);
      for (const [name, v] of numbers(r)) if (v !== null) expect(v, `${set} ${name}`).toBe(1);
      expect(r.lines.fp + r.lines.fn).toBe(0);
      expect(r.ruleLines.fundedByMistake).toBe(0);
      for (const [f, x] of Object.entries(r.flags)) expect(x.falseAlarmRate ?? 0, `${set} ${f} false alarms`).toBe(0);
      expect(r.spend).toMatchObject({ usdActual: 0, usdCeiling: 0 });
      expect(r.otherFlagsRaised).toEqual({});
    });
  }

  it("scores real numbers where the sets have something to find", async () => {
    const v1 = await run("v1");
    expect(v1.lines.tp).toBeGreaterThan(100);
    expect(v1.lineClass.den).toBeGreaterThan(100);
    expect(v1.pii.found.den).toBeGreaterThan(30);
    const adv = await run("adversarial");
    expect(adv.flags.duplicate.recall).toBe(1);
    expect(adv.flags.unreadable.tp).toBe(2);
    expect(adv.ruleLines.den).toBeGreaterThanOrEqual(13);
    expect(toMarkdown(adv, "t")).toContain("| duplicate | 100.0 % (3/3) |");
  });
});

describe("the benchmark notices a worse reader", () => {
  const damaged = (f: (r: ParsedReceipt) => ParsedReceipt): ReceiptReader => ({
    async read(image, hint) {
      const out = await recordedReader.read(image, hint);
      return { ...out, receipt: f(out.receipt) };
    },
  });

  it("drops of lines, wrong totals, dates and missed personal data lower the matching scores only", async () => {
    const r = await run("v1", damaged((x) => ({ ...x, lines: x.lines.slice(0, -1), totalMinor: x.totalMinor + 1, purchasedAt: x.purchasedAt!.replace("2026-11-0", "2026-11-1"), pii: [] })));
    expect(r.lines.recall).toBeLessThan(1);
    expect(r.lines.precision).toBe(1);
    expect(r.totalExact.rate).toBe(0);
    expect(r.dateExact.rate).toBe(0);
    expect(r.pii.found.rate).toBe(0);
    expect(r.merchant.meanSimilarity).toBe(1);
  });

  it("counts a duplicate that the reader garbled so the semantic key no longer matches", async () => {
    const r = await run("adversarial", damaged((x) => ({ ...x, merchantName: "Other Shop", totalMinor: x.totalMinor + 5 })));
    expect(r.flags.duplicate.recall).toBe(0);
  });

  it("counts rule lines the classifier would fund", async () => {
    const flip: LineClassifier = {
      async classify(input) {
        const out = await recordedClassifier.classify(input);
        return { ...out, lines: out.lines.map((l) => (l.ruleCode === "alcohol" ? { ...l, verdict: "eligible" as const, ruleCode: null, needId: "water", needQty: 1 } : l)) };
      },
    };
    const r = await run("adversarial", recordedReader, flip);
    expect(r.ruleLines.fundedByMistake).toBeGreaterThan(0);
    expect(r.ruleLines.rate).toBeLessThan(1);
    expect(r.lineClass.rate).toBeLessThan(1);
    expect(r.lines.f1).toBe(1);
  });

  it("flags nothing as unreadable when the reader says everything is fine, and records reader errors", async () => {
    const r = await run("adversarial", damaged((x) => ({ ...x, readability: "good" })));
    expect(r.flags.unreadable.recall).toBe(0);
    const broken: ReceiptReader = { read: async () => { throw new Error("boom"); } };
    const e = await run("hero", broken);
    expect(e.errors).toEqual([{ id: "hero-ja-01", stage: "read", message: "boom" }]);
    expect(e.lines.recall).toBe(0);
    expect(e.totalExact.rate).toBe(0);
  });

  it("a wrong need or quantity shows in the class and quantity scores", async () => {
    const swap: LineClassifier = {
      async classify(input) {
        const out = await recordedClassifier.classify(input);
        return { ...out, lines: out.lines.map((l) => (l.needId === "water" ? { ...l, needQty: (l.needQty ?? 0) + 1 } : l.needId === "diapers" ? { ...l, needId: "batteries" } : l)) };
      },
    };
    const r = await run("hero", recordedReader, swap);
    expect(r.needQty.num).toBeLessThan(r.needQty.den);
    expect(r.lineClass.num).toBe(r.lineClass.den - 3);
  });
});

describe("live answers", () => {
  it("counts a paid call that came back unusable and hands every receipt to onReceipt", async () => {
    const usage = { model: "m", tokensIn: 100, tokensOut: 5, usdCeiling: 0.01, usdActual: 0.001 };
    const broken: ReceiptReader = { read: async () => { throw Object.assign(new Error("bad answer"), { usage, raw: { lines: "x" } }); } };
    const seen: { id: string; errors: string[]; calls: number }[] = [];
    const truths = await loadTruths("hero");
    const r = await runEval({ readerName: "t", set: "hero", reader: broken, classifier: recordedClassifier, truths, known: [], onReceipt: (x) => { seen.push({ id: x.truth.id, errors: x.errors, calls: x.usage.length }); } });
    expect(r.spend).toMatchObject({ calls: 1, tokensIn: 100, usdActual: 0.001 });
    expect(seen).toEqual([{ id: "hero-ja-01", errors: ["read: bad answer", 'raw: {"lines":"x"}'], calls: 1 }]);
  });

  it("rebuilds replayable recordings from saved live files, leaving out failures", async () => {
    const t = (await loadTruths("hero"))[0];
    const dir = mkdtempSync(path.join(tmpdir(), "live-"));
    writeFileSync(path.join(dir, "a.json"), JSON.stringify({ receiptId: "a", imageSha256: t.image.sha256, reading: t.receipt, classifications: t.labels, usage: [], errors: [] }));
    writeFileSync(path.join(dir, "b.json"), JSON.stringify({ receiptId: "b", imageSha256: "0".repeat(64), reading: null, classifications: null, usage: [], errors: ["read: x"] }));
    const rec2 = await loadLiveRecordings(dir);
    expect(Object.keys(rec2.readings)).toEqual([t.image.sha256]);
    const bytes = new Uint8Array(readFileSync(path.resolve(__dirname, "../../eval/receipts/hero", t.image.file)));
    const again = await new RecordedReader(rec2).read({ bytes, mediaType: "image/png" });
    expect(again.receipt).toEqual(t.receipt);
    expect((await new RecordedClassifier(rec2).classify({ receipt: again.receipt, needs: [], rules: "" })).lines).toEqual(t.labels);
  });
});
