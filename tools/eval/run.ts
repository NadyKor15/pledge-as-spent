// Benchmark: how well a reader + classifier pass the receipt sets, scored against ground truth.
//   npm run eval -- --reader recorded|nova-lite|nova-pro|ocr-lite|ocr-pro|ocr-mix --set v1|adversarial|hero|holdout [--classifier <same choices>]
// Writes eval/results/<reader>-<set>-<UTC>.json and .md. The recorded reader replays the ground truth, so it must score 100 %.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BedrockNovaClassifier, BedrockNovaReader, NOVA_MODELS, createBedrockClient } from "../../src/receipts/bedrock";
import { OcrNovaReader, TesseractEngine, type ReadTrace } from "../../src/receipts/ocr";
import { RefiningClassifier } from "../../src/receipts/quantity";
import { TwoPassReader } from "../../src/receipts/twopass";
import { checkReceipt, fingerprint, type KnownReceipt } from "../../src/receipts/checks";
import { RecordedClassifier, RecordedReader, Recordings, classificationKey, receiptKey } from "../../src/receipts/recorded";
import { JsonlSpendLedger, SpendCap } from "../../src/receipts/spend";
import type { LineClassification, LineClassifier, ModelUsage, ParsedReceipt, ReceiptReader } from "../../src/receipts/types";
import { HERO_NEEDS, SCENARIOS } from "../receipts/scenario";
import { Truth } from "../receipts/truth";
import { FLAGS, add, flagStats, ratio, scoreReceipt, tally, type CheatFlag, type FlagTally, type ReceiptScore, type Tally } from "./metrics";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RECEIPTS = path.join(ROOT, "eval/receipts");

export type SetName = "v1" | "adversarial" | "hero" | "holdout";

export async function loadTruths(set: SetName, root = RECEIPTS): Promise<Truth[]> {
  const dir = path.join(root, set);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".truth.json")).sort();
  return Promise.all(files.map(async (f) => Truth.parse(JSON.parse(await readFile(path.join(dir, f), "utf8")))));
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
const rate = (t: Tally) => ({ ...t, rate: ratio(t.num, t.den) });

export interface EvalInput {
  readerName: string;
  set: SetName;
  reader: ReceiptReader;
  classifier: LineClassifier;
  truths: Truth[];
  /** Receipts already in the system; re-shots are looked up here. */
  known: Truth[];
  root?: string;
  /** Called once per receipt with what the reader and classifier returned, for saving live answers. */
  onReceipt?: (r: { truth: Truth; reading: ParsedReceipt | null; labels: LineClassification[] | null; usage: ModelUsage[]; errors: string[]; latencyMs: { read: number; classify: number | null } }) => Promise<void> | void;
}

export async function runEval(input: EvalInput) {
  const root = input.root ?? RECEIPTS;
  const knownFp: KnownReceipt[] = [];
  for (const [i, k] of input.known.entries()) {
    const bytes = new Uint8Array(await readFile(path.join(root, k.set, k.image.file)));
    knownFp.push({ ...fingerprint({ bytes, mediaType: "image/png" }, k.receipt), receiptId: k.id, uploadedAt: new Date(Date.UTC(2026, 10, 3, 0, i)).toISOString() });
  }

  const scores: ReceiptScore[] = [];
  const merchant: number[] = [];
  const totals = { total: tally(), date: tally(), dateTime: tally(), merchant80: tally() };
  const lineSum = { tp: 0, fp: 0, fn: 0 };
  const agg = { lineAmountExact: tally(), lineClass: tally(), needQty: tally(), ruleLines: tally(), pii: tally(), piiCovered: tally(), ruleLinesFunded: 0 };
  const ious: number[] = [];
  const flags: Record<CheatFlag, FlagTally> = Object.fromEntries(FLAGS.map((f) => [f, { tp: 0, fn: 0, fp: 0, tn: 0 }])) as never;
  const otherFlags: Record<string, number> = {};
  const byLocale: Record<string, { tp: number; fp: number; fn: number; total: Tally }> = {};
  const usage: ModelUsage[] = [];
  const errors: { id: string; stage: string; message: string }[] = [];
  const perReceipt: unknown[] = [];
  const latencies: { read: number; classify: number | null }[] = [];

  for (const t of input.truths) {
    const sc = t.locale === "ja" && t.set === "hero" ? { ...SCENARIOS.ja, needs: HERO_NEEDS } : SCENARIOS[t.locale];
    const bytes = new Uint8Array(await readFile(path.join(root, t.set, t.image.file)));
    const image = { bytes, mediaType: t.image.mediaType };
    let pred: ParsedReceipt | null = null;
    let labels: LineClassification[] | null = null;
    const mine: ModelUsage[] = [];
    const myErrors: string[] = [];
    // A call that came back unusable was still paid for: count it, and keep what it sent.
    const failedCall = (e: unknown) => {
      const u = (e as { usage?: ModelUsage }).usage;
      if (u) {
        usage.push(u);
        mine.push(u);
      }
      const raw = (e as { raw?: unknown }).raw;
      if (raw !== undefined) myErrors.push(`raw: ${JSON.stringify(raw)}`);
    };
    const clock = { read: 0, classify: null as number | null };
    const t0 = performance.now();
    try {
      const r = await input.reader.read(image, { currency: sc.drive.baseCurrency, languages: sc.languages });
      pred = r.receipt;
      usage.push(r.usage);
      mine.push(r.usage);
    } catch (e) {
      errors.push({ id: t.id, stage: "read", message: String(e instanceof Error ? e.message : e) });
      myErrors.push(`read: ${errors[errors.length - 1].message}`);
      failedCall(e);
    }
    clock.read = Math.round(performance.now() - t0);
    if (pred && pred.readability !== "unreadable") {
      try {
        const c = await input.classifier.classify({ receipt: pred, needs: sc.needs, rules: sc.drive.rules });
        labels = c.lines;
        usage.push(c.usage);
        mine.push(c.usage);
      } catch (e) {
        errors.push({ id: t.id, stage: "classify", message: String(e instanceof Error ? e.message : e) });
        myErrors.push(`classify: ${errors[errors.length - 1].message}`);
        failedCall(e);
      }
    }

    if (pred && pred.readability !== "unreadable") clock.classify = Math.round(performance.now() - t0 - clock.read);
    latencies.push(clock);
    await input.onReceipt?.({ truth: t, reading: pred, labels, usage: mine, errors: myErrors, latencyMs: clock });

    // Fraud flags from the deterministic checks, on what the reader returned.
    const others = knownFp.filter((k) => k.receiptId !== t.id);
    const raised = pred ? new Set(checkReceipt({ receipt: pred, drive: sc.drive, fingerprint: fingerprint(image, pred), known: others }).map((f) => f.code)) : new Set<string>();
    const expected: Record<CheatFlag, boolean> = { duplicate: t.expect.duplicateOf !== null, pre_disaster: t.expect.preDisaster, out_of_zone: t.expect.outOfZone, unreadable: t.expect.unreadable };
    for (const f of FLAGS) {
      const got = raised.has(f);
      const tl = flags[f];
      if (expected[f] && got) tl.tp++;
      else if (expected[f]) tl.fn++;
      else if (got) tl.fp++;
      else tl.tn++;
    }
    for (const code of raised) if (!(FLAGS as readonly string[]).includes(code)) otherFlags[code] = (otherFlags[code] ?? 0) + 1;

    let score: ReceiptScore | null = null;
    if (!t.expect.unreadable) {
      // A failed read scores as an empty one.
      const empty: ParsedReceipt = { ...t.receipt, merchantName: "", merchantAddress: null, purchasedAt: null, lines: [], pii: [], totalMinor: Number.NaN };
      score = scoreReceipt(t.receipt, t.labels, pred ?? empty, labels);
      scores.push(score);
      lineSum.tp += score.tp;
      lineSum.fp += score.fp;
      lineSum.fn += score.fn;
      add(totals.total, score.totalExact);
      add(totals.date, score.dateExact);
      add(totals.dateTime, score.dateTimeExact);
      add(totals.merchant80, score.merchantSimilarity >= 0.8);
      merchant.push(score.merchantSimilarity);
      for (const k of ["lineAmountExact", "lineClass", "needQty", "ruleLines", "pii", "piiCovered"] as const) {
        agg[k].num += score[k].num;
        agg[k].den += score[k].den;
      }
      agg.ruleLinesFunded += score.ruleLinesFunded;
      ious.push(...score.piiIou);
      const l = (byLocale[t.locale] ??= { tp: 0, fp: 0, fn: 0, total: tally() });
      l.tp += score.tp;
      l.fp += score.fp;
      l.fn += score.fn;
      add(l.total, score.totalExact);
    }
    perReceipt.push({ id: t.id, locale: t.locale, readability: pred?.readability ?? null, flags: [...raised], score });
  }

  const f1 = (tp: number, fp: number, fn: number) => {
    const p = ratio(tp, tp + fp);
    const r = ratio(tp, tp + fn);
    return { precision: p, recall: r, f1: p !== null && r !== null && p + r > 0 ? (2 * p * r) / (p + r) : p === null && r === null ? null : 0 };
  };
  const sum = (f: (u: ModelUsage) => number) => usage.reduce((s, u) => s + f(u), 0);
  return {
    reader: input.readerName,
    set: input.set,
    receipts: input.truths.length,
    scoredReceipts: scores.length,
    errors,
    lines: { ...f1(lineSum.tp, lineSum.fp, lineSum.fn), ...lineSum },
    lineAmountExact: rate(agg.lineAmountExact),
    totalExact: rate(totals.total),
    dateExact: rate(totals.date),
    dateTimeExact: rate(totals.dateTime),
    merchant: { meanSimilarity: merchant.length ? merchant.reduce((a, b) => a + b, 0) / merchant.length : null, atLeast80: rate(totals.merchant80) },
    lineClass: rate(agg.lineClass),
    needQty: rate(agg.needQty),
    ruleLines: { ...rate(agg.ruleLines), fundedByMistake: agg.ruleLinesFunded },
    pii: { found: rate(agg.pii), covered: rate(agg.piiCovered), meanIou: ious.length ? ious.reduce((a, b) => a + b, 0) / ious.length : null },
    flags: Object.fromEntries(FLAGS.map((f) => [f, flagStats(flags[f])])) as Record<CheatFlag, ReturnType<typeof flagStats>>,
    otherFlagsRaised: otherFlags,
    byLanguage: Object.fromEntries(Object.entries(byLocale).map(([k, v]) => [k, { ...f1(v.tp, v.fp, v.fn), totalExact: rate(v.total) }])),
    latency: { readerMedianMs: median(latencies.map((l) => l.read)), receiptMedianMs: median(latencies.map((l) => l.read + (l.classify ?? 0))) },
    spend: { ledgerDeltaUsd: null as number | null, calls: usage.length, tokensIn: sum((u) => u.tokensIn), tokensOut: sum((u) => u.tokensOut), usdActual: sum((u) => u.usdActual ?? u.usdCeiling), usdCeiling: sum((u) => u.usdCeiling) },
    perReceipt,
  };
}
export type EvalResult = Awaited<ReturnType<typeof runEval>>;

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${(n * 100).toFixed(1)} %`);
const t = (x: { num: number; den: number; rate: number | null }) => `${pct(x.rate)} (${x.num}/${x.den})`;

export function toMarkdown(r: EvalResult, when: string): string {
  const flagRows = FLAGS.map((f) => {
    const x = r.flags[f];
    return `| ${f} | ${pct(x.recall)} (${x.tp}/${x.tp + x.fn}) | ${x.fp} of ${x.fp + x.tn} (${pct(x.falseAlarmRate)}) |`;
  });
  const lang = Object.entries(r.byLanguage).map(([k, v]) => `| ${k} | ${pct(v.f1)} | ${pct(v.precision)} | ${pct(v.recall)} | ${t(v.totalExact)} |`);
  return `# Receipt benchmark: ${r.reader} on ${r.set}

Run ${when}. ${r.receipts} receipts (${r.scoredReceipts} scored on content; unreadable cases are scored on flags only). Reader errors: ${r.errors.length}.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | ${pct(r.lines.precision)} / ${pct(r.lines.recall)} / ${pct(r.lines.f1)} (tp ${r.lines.tp}, fp ${r.lines.fp}, fn ${r.lines.fn}) |
| Line amount exact (by line number) | ${t(r.lineAmountExact)} |
| Receipt total exact | ${t(r.totalExact)} |
| Date exact / date and time exact | ${t(r.dateExact)} / ${t(r.dateTimeExact)} |
| Merchant (fuzzy) mean similarity / at least 0.8 | ${pct(r.merchant.meanSimilarity)} / ${t(r.merchant.atLeast80)} |
| Line class (verdict + need) | ${t(r.lineClass)} |
| Need quantity exact (eligible lines) | ${t(r.needQty)} |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | ${t(r.ruleLines)}; funded by mistake: ${r.ruleLines.fundedByMistake} |
| Personal data found by text / covered by a blur box / mean box overlap | ${t(r.pii.found)} / ${t(r.pii.covered)} / ${pct(r.pii.meanIou)} |
| Median latency per receipt | reader ${r.latency.readerMedianMs ?? "n/a"} ms; reader + classifier ${r.latency.receiptMedianMs ?? "n/a"} ms |
| Spend | ${r.spend.calls} answered calls, ${r.spend.tokensIn} in / ${r.spend.tokensOut} out tokens, $${r.spend.usdActual.toFixed(4)} actual; ledger moved by ${r.spend.ledgerDeltaUsd === null ? "n/a" : "$" + r.spend.ledgerDeltaUsd.toFixed(4)} (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
${flagRows.join("\n")}

Other review flags raised (not scored): ${JSON.stringify(r.otherFlagsRaised)}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
${lang.join("\n")}
${r.errors.length ? `\n## Errors\n\n${r.errors.map((e) => `- ${e.id} (${e.stage}): ${e.message}`).join("\n")}\n` : ""}`;
}

/** One replayable file per receipt: the reading, the classifications, what they cost, and any error. */
async function saveLive(dir: string, x: Parameters<NonNullable<EvalInput["onReceipt"]>>[0] & { trace?: ReadTrace | null }) {
  await mkdir(dir, { recursive: true });
  const bytes = await readFile(path.join(RECEIPTS, x.truth.set, x.truth.image.file));
  const sc = x.truth.locale === "ja" && x.truth.set === "hero" ? { ...SCENARIOS.ja, needs: HERO_NEEDS } : SCENARIOS[x.truth.locale];
  const rec = {
    receiptId: x.truth.id,
    set: x.truth.set,
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
    reading: x.reading,
    classifications: x.labels,
    // The needs and rules the lines were matched against: a drive with others cannot reuse them.
    classifiedFor: x.reading ? classificationKey(x.reading, sc.needs, sc.drive.rules) : null,
    usage: x.usage,
    latencyMs: x.latencyMs,
    errors: x.errors,
    trace: x.trace ?? null,
  };
  await writeFile(path.join(dir, `${x.truth.id}.json`), JSON.stringify(rec, null, 1) + "\n");
}

/** Rebuilds recorder input from saved live answers; receipts that failed are left out. */
export async function loadLiveRecordings(dir: string): Promise<Recordings> {
  const rec: Recordings = { readings: {}, classifications: {} };
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
    const x = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    if (!x.reading) continue;
    rec.readings[x.imageSha256] = x.reading;
    if (x.classifications) rec.classifications[receiptKey(x.reading)] = x.classifications;
  }
  return Recordings.parse(rec);
}

type Choice = "recorded" | "nova-lite" | "nova-pro" | "nova-lite-2pass" | "nova-pro-2pass" | "ocr-lite" | "ocr-pro" | "ocr-mix";
const CHOICES: Choice[] = ["recorded", "nova-lite", "nova-pro", "nova-lite-2pass", "nova-pro-2pass", "ocr-lite", "ocr-pro", "ocr-mix"];
const OCR_CHOICES: Choice[] = ["ocr-lite", "ocr-pro", "ocr-mix"];
/** The model that classifies lines for a reader choice: the reader's own model (ocr-mix: Lite copies the numbers, Pro does the rest). */
const classifierFor = (c: Choice): Choice => (c === "ocr-lite" ? "nova-lite" : c === "ocr-pro" || c === "ocr-mix" ? "nova-pro" : (c.replace(/-2pass$/, "") as Choice));

const TESSDATA = path.join(ROOT, "vendor/tessdata");

async function build(choice: Choice, ledger: SpendCap | null, recordings: Recordings, engine: TesseractEngine, trace?: (t: ReadTrace) => void) {
  if (choice === "recorded") return { reader: new RecordedReader(recordings), classifier: new RecordedClassifier(recordings) };
  const cap = ledger!;
  const client = createBedrockClient();
  const modelId = choice === "nova-lite" || choice === "nova-lite-2pass" || choice === "ocr-lite" ? NOVA_MODELS.lite : NOVA_MODELS.pro;
  const inner = new BedrockNovaClassifier({ client, cap, modelId });
  // The OCR readers' classifier answers go through the deterministic quantity and forbidden-name checks.
  const isOcr = OCR_CHOICES.includes(choice);
  const classifier = isOcr ? new RefiningClassifier(inner) : inner;
  if (choice.endsWith("-2pass")) return { reader: new TwoPassReader({ client, cap, modelId }), classifier };
  if (isOcr) return { reader: new OcrNovaReader({ client, cap, modelId, engine, numbersModelId: choice === "ocr-mix" ? NOVA_MODELS.lite : modelId, trace }), classifier };
  return { reader: new BedrockNovaReader({ client, cap, modelId }), classifier };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const readerChoice = arg("reader") as Choice | undefined;
  const set = arg("set") as SetName | undefined;
  if (!readerChoice || !CHOICES.includes(readerChoice) || !set || !["v1", "adversarial", "hero", "holdout"].includes(set)) {
    throw new Error(`usage: npm run eval -- --reader ${CHOICES.join("|")} --set v1|adversarial|hero [--classifier ${CHOICES.join("|")}]`);
  }
  const classifierChoice = (arg("classifier") as Choice | undefined) ?? classifierFor(readerChoice);
  const recordings = Recordings.parse(JSON.parse(await readFile(path.join(RECEIPTS, "recorded.json"), "utf8")));
  const live = readerChoice !== "recorded" || classifierChoice !== "recorded";
  const cap = live ? new SpendCap(new JsonlSpendLedger(process.env.SPEND_LEDGER ?? path.join(ROOT, "eval/spend-ledger.jsonl")), process.env.SPEND_MAX_USD ? Number(process.env.SPEND_MAX_USD) : undefined) : null;
  const engine = new TesseractEngine(TESSDATA);
  let trace: ReadTrace | null = null;
  const r = await build(readerChoice, cap, recordings, engine, (t) => {
    trace = t;
  });
  // The reader's own classifier unless another one was asked for: the OCR readers' goes through the deterministic checks.
  const c = classifierChoice === classifierFor(readerChoice) ? r : await build(classifierChoice, cap, recordings, engine);
  const name = classifierChoice === classifierFor(readerChoice) ? readerChoice : `${readerChoice}+${classifierChoice}`;

  const truths = await loadTruths(set);
  const ledgerBefore = cap ? await cap.ledger.total() : null;
  const known = set === "v1" ? truths : await loadTruths("v1");
  const liveDir = live ? path.join(ROOT, "eval/live", name) : null;
  const result = await runEval({
    readerName: name,
    set,
    reader: r.reader,
    classifier: c.classifier,
    truths,
    known,
    onReceipt: liveDir
      ? async (x) => {
          await saveLive(liveDir, { ...x, trace });
          trace = null;
        }
      : undefined,
  });

  await engine.close();
  if (cap) result.spend.ledgerDeltaUsd = (await cap.ledger.total()) - ledgerBefore!;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = path.join(ROOT, "eval/results", `${result.reader}-${set}-${stamp}`);
  await mkdir(path.dirname(base), { recursive: true });
  await writeFile(`${base}.json`, JSON.stringify(result, null, 1) + "\n");
  await writeFile(`${base}.md`, toMarkdown(result, stamp));
  console.log(toMarkdown(result, stamp));
  console.log(`written ${path.relative(ROOT, base)}.json and .md`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
