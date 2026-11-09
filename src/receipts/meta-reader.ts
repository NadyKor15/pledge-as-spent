// Receipt reading by Meta's models only, twice and independently. Reading A: Muse Spark on the whole photo. Reading B:
// Muse Spark on the numbered cuts of the printed rows that code found by pixels (src/receipts/slice.ts). One Spark
// text call classifies the lines of both. A line passes only when the two readings agree on its amount (exactly,
// in minor units), on the quantity code derives from each (src/receipts/quantity.ts) and on the need; otherwise a
// person is asked. Models read and classify; code compares, counts and decides money.

import { z } from "zod";
import type { CurrencyCode, Need } from "../core/types";
import { classificationsFromWire, CLASSIFIER_SYSTEM, kv, minorUnits, ModelOutputError, READER_SYSTEM, receiptFromText } from "./bedrock";
import { imagePart, metaRespond, type MetaOptions } from "./meta";
import { deriveNeedQty, forbiddenCategory, refineClassifications } from "./quantity";
import { cutRows, sliceReceipt, type Slicing } from "./slice";
import { sumUsage, validateReceipt } from "./structure";
import {
  LineClassification,
  ParsedReceipt,
  type Agreement,
  type Band,
  type LineBox,
  type LineClassifier,
  type ModelUsage,
  type PurchaseLine,
  type ReceiptImage,
  type ReceiptReader,
  type SecondReading,
} from "./types";

// ------------------------------------------------------------------------------------------------ reading A

/** The whole photo, the same plain-text form as the other readers. */
/** What a subtotal is, for both readings: a tax base (BASE, MATRAH, 対象) is never one. */
const SUBTOTAL_RULE = "- subtotal is only a row printed as a subtotal (小計, SUBTOTAL, ARA TOPLAM, SUBTOTAL); a tax base (BASE, BASE IMPONIBLE, MATRAH, 対象) is never the subtotal, and when no subtotal row is printed, leave subtotal out.";

export const READ_A_SYSTEM = READER_SYSTEM.replace("\n- PII rows", `\n${SUBTOTAL_RULE}\n- PII rows`);

// ------------------------------------------------------------------------------------------------ reading B

const FORM_START = READER_SYSTEM.indexOf("RECEIPT: merchant=");
const RULES_START = READER_SYSTEM.indexOf("Rules:");
const FORM_ROWS = READER_SYSTEM.slice(FORM_START, READER_SYSTEM.indexOf("\nPII:", FORM_START));
const RULES = READER_SYSTEM.slice(RULES_START, READER_SYSTEM.indexOf("\n- PII rows", RULES_START));

export const READ_B_SYSTEM = `You read the printed rows of one store receipt for a disaster-relief fundraiser and report exactly what is printed.
You are given numbered cuts: each cut is one printed row of the receipt, cut out of the photo, in print order from top to bottom; its number is printed in red on the left.
Answer in plain text only, nothing else. First one BAND row for every number, in order:
BAND: n=<number>; text=<the row exactly as printed, in its original script; leave text empty when nothing on the cut is readable>
Then the receipt, in this form (one row per line; leave a key out when it is not printed; never guess):
${FORM_ROWS.replace(/en=<short English name>/, "en=<short English name>; bands=<the numbers of the cuts this line is printed on>")}
${RULES}
- A row that only gives a quantity and a unit price ("2点 x 単858", "2 x 9,45", "3 @ $1.39") belongs to the product line above it: it supplies qty and unit; amount is the line total printed for that product, and you never multiply or add anything yourself.
- readability is unreadable when you cannot read the lines, poor when parts are doubtful, otherwise good.
${SUBTOTAL_RULE}
- bands lists every cut that prints this line: its name (and the rest of a name that wraps), its pack size, its quantity and unit-price row, and its amount; no other cut. A discount line lists its own cut.
- Do not make rows for personal data.`;

/** The third reading: one disputed line, its printed rows cut out large. */
export const READ_C_SYSTEM = `You read one line of a store receipt for a disaster-relief fundraiser, cut out of the photo: one to four printed rows that belong to one product. Report exactly what is printed, nothing else, in one row of plain text:
LINE: qty=<quantity>; unit=<unit price>; amount=<line total>; text=<the product name as printed>; en=<short English name>
- Leave a key out when it is not printed; never guess, never multiply or add.
- A row that only gives a quantity and a unit price ("2点 x 単858", "2 x 9,45", "3 @ $1.39") gives qty and unit; amount is the line total printed for the product.
- Amounts are integers in minor units: whole yen for JPY; hundredths for USD, EUR and TRY (12.50 is 1250).`;

const EMPTY = new Set(["", "null", "none", "n/a", "-"]);
const LINE_KEYS = ["no", "qty", "unit", "amount", "rate", "text", "en"];

/**
 * Reading B's answer: the text of every cut, the receipt (validated later), and for each kept line the cuts it says it
 * is printed on. Lines without an amount are left out exactly as receiptFromText leaves them out, so the i-th entry of
 * `lineBands` belongs to the i-th line of the receipt.
 */
export function parseSecond(answer: string): { bandTexts: Record<string, string>; receipt: unknown; lineBands: number[][] } {
  const bandTexts: Record<string, string> = {};
  const lineBands: number[][] = [];
  const kept: string[] = [];
  for (const raw of answer.split(/\r?\n/)) {
    const row = raw.replace(/^[\s*•-]+/, "").trim();
    const band = row.match(/^BAND\s*:\s*(.*)$/i);
    if (band) {
      const f = kv(band[1], ["n", "text"]);
      const n = Number(f?.n);
      if (Number.isInteger(n) && n > 0) bandTexts[String(n)] = (f?.text ?? "").trim();
      continue;
    }
    const line = row.match(/^LINE\s*:\s*(.*)$/i);
    if (!line) {
      kept.push(row);
      continue;
    }
    const m = line[1].match(/;\s*bands\s*[=:]\s*([\d,\s]*)\s*(?=;|$)/i);
    const bands = m ? [...new Set(m[1].split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
    const rest = m ? line[1].replace(m[0], "") : line[1];
    const f = kv(rest, LINE_KEYS) ?? {};
    if (!EMPTY.has((f.amount ?? "").trim().toLowerCase())) lineBands.push(bands);
    kept.push(`LINE: ${rest}`);
  }
  return { bandTexts, receipt: receiptFromText(kept.join("\n")), lineBands };
}

/** The cut numbers listed on a sheet, as text the model reads before the image. */
const sheetNote = (s: Slicing["sheets"][number], n: number, of: number) => `Sheet ${n} of ${of}: cuts ${s.first} to ${s.last}.`;

// ------------------------------------------------------------------------------------------------ the two readings

export interface MetaReaderOptions extends MetaOptions {
  /** Slices the photo; a test can hand in its own bands. */
  slice?: (image: ReceiptImage) => Slicing;
}

/** Both readings, at the same time. Reading A is the receipt; reading B comes back beside it as `second`. */
export class MetaTwoReadings implements ReceiptReader {
  constructor(private readonly o: MetaReaderOptions) {}

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    this.currency = hint.currency;
    const intro = `Expected currency: ${hint.currency} (report the currency actually printed). Likely languages: ${hint.languages.join(", ")}.`;
    const [a, b] = await Promise.allSettled([this.readA(image, intro), this.readB(image, intro)]);
    const bUsage = b.status === "fulfilled" ? b.value.usage : ((b.reason as { usage?: ModelUsage })?.usage ?? null);
    if (a.status === "rejected") {
      // Whatever failed, the calls already made were paid for.
      const e = a.reason as { usage?: ModelUsage };
      if (e && typeof e === "object") e.usage = sumUsage([e.usage, bUsage].filter((u): u is ModelUsage => !!u));
      throw a.reason;
    }
    const second: SecondReading =
      b.status === "fulfilled"
        ? b.value.second
        : { receipt: null, lineBands: [], bandTexts: {}, bands: [], size: null, error: String((b.reason as Error)?.message ?? b.reason).slice(0, 300) };
    const usage = sumUsage([a.value.usage, ...(bUsage ? [bUsage] : [])]);
    return { receipt: a.value.receipt, usage, second };
  }

  private async readA(image: ReceiptImage, intro: string) {
    const what = "read A (whole photo)";
    const { text, usage } = await metaRespond(this.o, { what, instructions: READ_A_SYSTEM, parts: [{ type: "input_text", text: intro }, imagePart(image)] });
    let obj: Record<string, unknown>;
    try {
      obj = receiptFromText(text) as Record<string, unknown>;
    } catch (e) {
      throw Object.assign(new ModelOutputError(`${what}: ${e instanceof Error ? e.message : String(e)}`), { usage, raw: text });
    }
    // A photo the model calls unreadable comes back as such (no lines, nothing to fund), so the checks flag it.
    if (obj.readability === "unreadable") obj = { ...obj, currency: obj.currency ?? this.currency, totalMinor: typeof obj.totalMinor === "number" ? obj.totalMinor : 0, lines: [] };
    return { receipt: validateReceipt(obj, what, usage, text), usage };
  }

  private currency: string = "";

  private async readB(image: ReceiptImage, intro: string): Promise<{ second: SecondReading; usage: ModelUsage }> {
    const what = "read B (numbered rows)";
    const slicing = (this.o.slice ?? sliceReceipt)(image);
    if (slicing.bands.length === 0) throw new ModelOutputError(`${what}: no printed rows were found on the photo`);
    const parts = [
      { type: "input_text" as const, text: `${intro} ${slicing.bands.length} cuts on ${slicing.sheets.length} sheet(s).` },
      ...slicing.sheets.flatMap((s, i) => [{ type: "input_text" as const, text: sheetNote(s, i + 1, slicing.sheets.length) }, imagePart(s)]),
    ];
    const { text, usage } = await metaRespond(this.o, { what, instructions: READ_B_SYSTEM, parts });
    let parsed: ReturnType<typeof parseSecond>;
    try {
      parsed = parseSecond(text);
    } catch (e) {
      throw Object.assign(new ModelOutputError(`${what}: ${e instanceof Error ? e.message : String(e)}`), { usage, raw: text });
    }
    // Reading B's currency is never used for money (amounts are compared with reading A's): a missing one is the drive's.
    const rb = parsed.receipt as Record<string, unknown>;
    const receipt = validateReceipt({ ...rb, currency: rb.currency ?? this.currency, pii: [] }, what, usage, text);
    return { second: { receipt, lineBands: parsed.lineBands, bandTexts: parsed.bandTexts, bands: slicing.bands, size: { width: slicing.width, height: slicing.height }, error: null }, usage };
  }
}

// ------------------------------------------------------------------------------------------------ classification

/** Lines of reading B are numbered from here in the one classification call, so the two never share a number. */
export const SECOND_OFFSET = 1000;

const ANSWER_FORM =
  'Answer in plain text only: one row per line, "no=<lineNo>; need=<needId>; qty=<quantity in the need unit>; verdict=<eligible|rejected|review>; rule=<ruleCode>; conf=<0..1>; why=<one sentence>". Leave out need, qty and rule when they do not apply.';

/** The classifier's raw answers for both readings, before any comparison. */
export interface RawClassification {
  first: LineClassification[];
  second: LineClassification[];
  /** Third readings of disputed lines, by line number of reading A (null: it gave no usable line). */
  third?: Record<string, Line | null>;
  usage: ModelUsage;
}

export interface RawClassifier {
  classifyBoth(input: { receipt: ParsedReceipt; second: ParsedReceipt | null; needs: Need[]; rules: string }): Promise<RawClassification>;
}

/** Muse Spark classifies the lines of both readings in one text call (no image), with the classifier prompt of the other readers. */
export class MetaRawClassifier implements RawClassifier {
  constructor(private readonly o: MetaOptions) {}

  async classifyBoth(input: { receipt: ParsedReceipt; second: ParsedReceipt | null; needs: Need[]; rules: string }): Promise<RawClassification> {
    const asked = [
      ...input.receipt.lines.map((l) => ({ ...l, ask: l.lineNo })),
      ...(input.second?.lines ?? []).map((l) => ({ ...l, ask: l.lineNo + SECOND_OFFSET })),
    ];
    const first = await this.ask(input, asked, "classify");
    const answered = new Set(first.lines.map((l) => l.lineNo));
    const missing = asked.filter((l) => !answered.has(l.ask));
    let lines = first.lines;
    const usages = [first.usage];
    // An unanswered line is never funded, so it is worth one more question, about those lines alone.
    if (missing.length) {
      try {
        const again = await this.ask(input, missing, "classify again");
        const wanted = new Set(missing.map((l) => l.ask));
        lines = [...lines, ...again.lines.filter((l) => wanted.has(l.lineNo))];
        usages.push(again.usage);
      } catch (e) {
        if (!(e instanceof ModelOutputError)) throw e;
        if (e.usage) usages.push(e.usage);
      }
    }
    return {
      first: lines.filter((l) => l.lineNo < SECOND_OFFSET).sort((a, b) => a.lineNo - b.lineNo),
      second: lines.filter((l) => l.lineNo > SECOND_OFFSET).map((l) => ({ ...l, lineNo: l.lineNo - SECOND_OFFSET })).sort((a, b) => a.lineNo - b.lineNo),
      usage: sumUsage(usages),
    };
  }

  private async ask(input: { receipt: ParsedReceipt; needs: Need[]; rules: string }, asked: (ParsedReceipt["lines"][number] & { ask: number })[], what: string) {
    const needs = input.needs.map((n) => ({ id: n.id, label: n.label, unit: n.unit, qtyNeeded: n.qtyNeeded }));
    const lines = asked.map((l) => ({ lineNo: l.ask, rawText: l.rawText, translationEn: l.translationEn, qty: l.qty, amountMinor: l.amountMinor }));
    const { text, usage } = await metaRespond(this.o, {
      what,
      instructions: `${CLASSIFIER_SYSTEM}\n${ANSWER_FORM}`,
      parts: [
        {
          type: "input_text",
          text: `Drive rules:\n${input.rules}\n\nNeeds (JSON):\n${JSON.stringify(needs)}\n\nReceipt from ${input.receipt.merchantName} (${input.receipt.currency}). Lines (JSON):\n${JSON.stringify(lines)}\n\nAnswer for every one of the ${lines.length} lines: ${lines.length} rows, one per lineNo.`,
        },
      ],
    });
    try {
      const parsed = z.array(LineClassification).safeParse(classificationsFromWire({ lines: text }));
      if (!parsed.success) throw new Error(`output does not match the schema: ${z.prettifyError(parsed.error)}`);
      return { lines: parsed.data, usage };
    } catch (e) {
      throw Object.assign(new ModelOutputError(`${what}: ${e instanceof Error ? e.message : String(e)}`), { usage, raw: text });
    }
  }
}

// ------------------------------------------------------------------------------------------------ comparison

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function similarity(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (!x.length && !y.length) return 1;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

type Line = ParsedReceipt["lines"][number];

/** Pairs each line of A with the line of B of the same amount whose text is closest (nearest position on a tie). */
export function pairLines(a: Line[], b: Line[]): Map<number, number> {
  const used = new Set<number>();
  const pairs = new Map<number, number>();
  a.forEach((x, ai) => {
    let best = -1;
    let bestSim = -1;
    b.forEach((y, bi) => {
      if (used.has(bi) || y.amountMinor !== x.amountMinor) return;
      const sim = similarity(x.rawText, y.rawText);
      if (sim > bestSim || (sim === bestSim && Math.abs(bi - ai) < Math.abs(best - ai))) {
        best = bi;
        bestSim = sim;
      }
    });
    if (best >= 0) {
      used.add(best);
      pairs.set(x.lineNo, b[best].lineNo);
    }
  });
  return pairs;
}

const FORBIDDEN = new Set(["alcohol", "tobacco", "gift_card"]);

const review = (c: LineClassification | undefined, lineNo: number, why: string): LineClassification => ({
  lineNo,
  needId: null,
  needQty: null,
  verdict: "review",
  ruleCode: "unclear",
  reasonEn: why,
  confidence: Math.min(c?.confidence ?? 0.5, 0.5),
});

const sayClass = (c: LineClassification | undefined) =>
  !c ? "no answer" : c.verdict === "eligible" ? `${c.needQty ?? "?"} for ${c.needId}` : c.verdict === "rejected" ? `refused (${c.ruleCode})` : "unsure";

/**
 * Cuts a line may open on a closed copy: listed by reading B, printed close together (at most 4 cuts, within 5 rows),
 * and none of them carrying text that either reading named as personal data. Anything else: no cut at all.
 */
export function trustedBands(listed: number[], second: SecondReading, personal: string[]): number[] {
  const known = new Set(second.bands.map((b) => b.index));
  const ids = [...new Set(listed)].filter((n) => known.has(n)).sort((x, y) => x - y);
  if (ids.length === 0 || ids.length !== new Set(listed).size || ids.length > 4 || ids[ids.length - 1] - ids[0] > 4) return [];
  const secrets = personal.map(fold).filter((s) => s.length >= 4);
  const digits = personal.map((p) => p.replace(/\D/g, "")).filter((d) => d.length >= 4);
  for (const n of ids) {
    const t = second.bandTexts[String(n)] ?? "";
    const f = fold(t);
    const d = t.replace(/\D/g, "");
    if (secrets.some((s) => f.includes(s)) || digits.some((s) => d.includes(s.slice(-4)) && s.length >= 8)) return [];
  }
  return ids;
}

/** The box around some bands, in fractions 0..1 of the photo. */
export function boxOf(bands: Band[], width: number, height: number): LineBox["box"] | null {
  if (!bands.length || width <= 0 || height <= 0) return null;
  const xs = bands.flatMap((b) => b.quad.map((p) => p[0]));
  const ys = bands.flatMap((b) => b.quad.map((p) => p[1]));
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp(Math.min(...xs) / width);
  const y = clamp(Math.min(...ys) / height);
  const w = clamp(Math.max(...xs) / width) - x;
  const h = clamp(Math.max(...ys) / height) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The comparison. For each line of reading A (refined by code on both sides first):
 * - a refusal for alcohol, tobacco or a gift card by either reading stands (a refusal never moves money);
 * - both eligible for the same need with the same quantity, at the same amount: eligible;
 * - both refused: refused;
 * - anything else, or no line of B at that amount: a person is asked, with both answers in the reason.
 * When the two readings disagree on the receipt's total or date, every eligible line is held. A discount B does not
 * confirm holds the line it belongs to.
 */
export function compareReadings(input: {
  receipt: ParsedReceipt;
  second: SecondReading;
  needs: Need[];
  raw: { first: LineClassification[]; second: LineClassification[]; third?: Record<string, Line | null> };
}): { lines: LineClassification[]; agreement: Agreement; asks: ThirdAsk[] } {
  const asks: ThirdAsk[] = [];
  const third = input.raw.third ?? {};
  const a = input.receipt;
  const b = input.second.receipt;
  const first = refineClassifications(a, input.needs, input.raw.first);
  const held: { lineNo: number; why: string }[] = [];
  const hold = (c: LineClassification | undefined, lineNo: number, why: string) => {
    held.push({ lineNo, why });
    return review(c, lineNo, why);
  };
  const byNo = (cs: LineClassification[]) => new Map(cs.map((c) => [c.lineNo, c]));
  const clsA = byNo(first);
  if (!b) {
    const why = `The second reading of this receipt failed (${input.second.error ?? "no answer"}), so a person should confirm this line.`;
    const lines = a.lines.map((l) => {
      const c = clsA.get(l.lineNo);
      if (l.amountMinor < 0 || !c || c.verdict !== "eligible") return c ?? hold(undefined, l.lineNo, why);
      return hold(c, l.lineNo, why);
    });
    return { lines, agreement: { purchaseLines: [], lineBoxes: [], raw: input.raw, held }, asks };
  }
  const personal = a.pii.map((p) => p.text);
  const bandsOfB = (bNo: number) => trustedBands(input.second.lineBands[b.lines.findIndex((x) => x.lineNo === bNo)] ?? [], input.second, personal);
  const needOf = (id: string | null) => input.needs.find((n) => n.id === id);
  const clsB = byNo(refineClassifications(b, input.needs, input.raw.second));
  const pairs = pairLines(a.lines, b.lines);
  const out = new Map<number, LineClassification>();
  for (const l of a.lines) {
    const c = clsA.get(l.lineNo);
    const bNo = pairs.get(l.lineNo);
    const d = bNo === undefined ? undefined : clsB.get(bNo);
    if (l.amountMinor < 0) {
      if (c) out.set(l.lineNo, c);
      continue;
    }
    const forbiddenA = c?.verdict === "rejected" && c.ruleCode && FORBIDDEN.has(c.ruleCode) ? c : null;
    const forbiddenB = d?.verdict === "rejected" && d.ruleCode && FORBIDDEN.has(d.ruleCode) ? d : null;
    if (forbiddenA) {
      out.set(l.lineNo, forbiddenA);
      continue;
    }
    if (forbiddenB) {
      out.set(l.lineNo, { ...forbiddenB, lineNo: l.lineNo });
      continue;
    }
    // A name code knows as forbidden is refused whatever either model said (refineClassifications does it for A).
    if (forbiddenCategory(`${l.rawText} ${l.translationEn}`) && c) {
      out.set(l.lineNo, c);
      continue;
    }
    if (!c) {
      out.set(l.lineNo, hold(undefined, l.lineNo, "The classifier did not answer for this line, so a person should confirm it."));
      continue;
    }
    if (bNo === undefined) {
      if (c.verdict !== "eligible") {
        out.set(l.lineNo, c);
        continue;
      }
      // The second reading may have misread the amount: the line of B with the same name and need, if any, is read a
      // third time, and the line passes only when that reading prints this amount, adds up, and gives the same quantity.
      const used = new Set(pairs.values());
      const near = b.lines
        .filter((y) => !used.has(y.lineNo) && y.amountMinor >= 0 && similarity(l.rawText, y.rawText) >= 0.6)
        .map((y) => ({ y, d: clsB.get(y.lineNo) }))
        .find((x) => x.d?.verdict === "eligible" && x.d.needId === c.needId);
      const ids = near ? bandsOfB(near.y.lineNo) : [];
      const t = third[String(l.lineNo)];
      if (near && ids.length && t !== undefined) {
        const q = t && t.amountMinor === l.amountMinor && addsUp(t) ? quantityOf(t, needOf(c.needId)) : null;
        if (q !== null && q === c.needQty) {
          out.set(l.lineNo, { ...c, confidence: Math.min(c.confidence, near.d!.confidence) });
          continue;
        }
      } else if (near && ids.length) asks.push({ lineNo: l.lineNo, bandIndexes: ids, kind: "missing" });
      out.set(l.lineNo, hold(c, l.lineNo, `The second reading found no line at this amount (${l.amountMinor}), so a person should confirm it.`));
      continue;
    }
    if (c.verdict === "eligible" && d?.verdict === "eligible" && c.needId === d.needId && c.needQty === d.needQty) {
      out.set(l.lineNo, { ...c, confidence: Math.min(c.confidence, d.confidence) });
      continue;
    }
    if (c.verdict === "eligible" && d?.verdict === "eligible" && c.needId === d.needId) {
      // Same product, same need, same amount, another quantity. Arithmetic first: the reading whose quantity times
      // unit price makes the printed amount wins, when the other's does not. Then a third reading of the line's rows:
      // it decides only by agreeing with one of the two and adding up itself. Otherwise a person is asked.
      const lb = b.lines.find((y) => y.lineNo === bNo)!;
      const okA = addsUp(l);
      const okB = addsUp(lb);
      if (okA !== okB) {
        out.set(l.lineNo, { ...(okA ? c : { ...c, needQty: d.needQty }), confidence: Math.min(c.confidence, d.confidence) });
        continue;
      }
      const t = third[String(l.lineNo)];
      const ids = bandsOfB(bNo);
      if (t !== undefined) {
        const q = t && t.amountMinor === l.amountMinor && addsUp(t) ? quantityOf(t, needOf(c.needId)) : null;
        if (q !== null && (q === c.needQty || q === d.needQty)) {
          out.set(l.lineNo, { ...c, needQty: q, confidence: Math.min(c.confidence, d.confidence) });
          continue;
        }
      } else if (ids.length) asks.push({ lineNo: l.lineNo, bandIndexes: ids, kind: "quantity" });
    }
    if (c.verdict === "rejected" && d?.verdict === "rejected") {
      out.set(l.lineNo, c);
      continue;
    }
    out.set(l.lineNo, hold(c, l.lineNo, `The two readings disagree on this line: the first says ${sayClass(c)}, the second ${sayClass(d)}.`));
  }
  // A discount the second reading does not confirm changes what the line above costs: hold that line.
  a.lines.forEach((l, i) => {
    if (l.amountMinor >= 0 || pairs.has(l.lineNo)) return;
    const above = a.lines.slice(0, i).reverse().find((x) => x.amountMinor >= 0);
    const c = above ? out.get(above.lineNo) : undefined;
    if (above && c?.verdict === "eligible") out.set(above.lineNo, hold(c, above.lineNo, `The second reading does not confirm the discount of ${l.amountMinor} on this line, so a person should confirm it.`));
  });
  // The receipt as a whole: total and date gate every line.
  const dateA = a.purchasedAt?.slice(0, 10) ?? null;
  const dateB = b.purchasedAt?.slice(0, 10) ?? null;
  const whole = a.totalMinor !== b.totalMinor ? `The two readings disagree on the receipt's total (${a.totalMinor} and ${b.totalMinor}).` : dateA !== dateB ? `The two readings disagree on the receipt's date (${dateA} and ${dateB}).` : null;
  if (whole) for (const [no, c] of out) if (c.verdict === "eligible") out.set(no, hold(c, no, `${whole} A person should confirm this line.`));

  // Purchase lines and their rows: only lines both readings found, on cuts reading B named and nothing personal.
  const bandByIndex = new Map(input.second.bands.map((x) => [x.index, x]));
  const purchaseLines: PurchaseLine[] = [];
  const lineBoxes: LineBox[] = [];
  // First the cuts reading B named; then every physical row of the line: a cut between two of its cuts, and the
  // quantity row right under it ("2点 x 単858", "2 x 9,45", "3 @ $1.39") when no other line names it. The check for
  // personal data runs again on the widened set: a row with any of it closes the whole line.
  const named = new Map<number, number[]>();
  for (const l of a.lines) {
    const bNo = pairs.get(l.lineNo);
    if (bNo === undefined) continue;
    const ids = trustedBands(input.second.lineBands[b.lines.findIndex((x) => x.lineNo === bNo)] ?? [], input.second, personal);
    if (ids.length) named.set(l.lineNo, ids);
  }
  const claimed = new Set([...named.values()].flat());
  const QTY_ROW = /^\s*[\d.,]+\s*(?:点|個|本)?\s*[x×@*]\s*(?:単|@)?\s*[¥$€₺]?\s*[\d.,]+/i;
  for (const l of a.lines) {
    const base = named.get(l.lineNo);
    if (!base) continue;
    const wide = new Set(base);
    for (let n = base[0]; n <= base[base.length - 1]; n++) if (!claimed.has(n) || base.includes(n)) wide.add(n);
    const next = base[base.length - 1] + 1;
    if (!claimed.has(next) && QTY_ROW.test(input.second.bandTexts[String(next)] ?? "")) wide.add(next);
    const ids = trustedBands([...wide], input.second, personal);
    if (!ids.length) continue;
    purchaseLines.push({ lineNo: l.lineNo, bandIndexes: ids });
    const size = input.second.size;
    const box = size ? boxOf(ids.map((n) => bandByIndex.get(n)!), size.width, size.height) : null;
    if (box) lineBoxes.push({ lineNo: l.lineNo, box });
  }
  const lines = a.lines.map((l) => out.get(l.lineNo)).filter((c): c is LineClassification => !!c);
  // A held line that a later step passed is not held any more.
  const stillHeld = held.filter((h) => out.get(h.lineNo)?.verdict === "review");
  return { lines, agreement: { purchaseLines, lineBoxes, raw: input.raw, held: stillHeld }, asks: asks.filter((x) => out.get(x.lineNo)?.verdict === "review") };
}

/** A disputed line the third reading should read: its rows on the photo. */
export interface ThirdAsk {
  lineNo: number;
  bandIndexes: number[];
  kind: "quantity" | "missing";
}

/**
 * Whether a line adds up: printed quantity times printed unit price is the printed amount, exactly in minor units.
 * A line that prints neither is one item at its amount; a unit price alone must be the amount; a quantity alone
 * adds up only when it is one. (A discount is its own line and does not change the amount of the line above.)
 */
export function addsUp(l: Pick<Line, "qty" | "unitPriceMinor" | "amountMinor">): boolean {
  const q = l.qty;
  const u = l.unitPriceMinor;
  if (q !== null && !(Number.isInteger(q) && q > 0)) return false;
  if (q === null && u === null) return true;
  if (q === null) return u === l.amountMinor;
  if (u === null) return q === 1;
  return q * u === l.amountMinor;
}

/** The quantity in the need's unit that code derives from a line (src/receipts/quantity.ts), one item when it says nothing. */
function quantityOf(l: Line, need: Need | undefined): number | null {
  if (!need) return null;
  return deriveNeedQty(l, need) ?? 1;
}

/**
 * The line classifier of the Meta path: one raw classification of both readings, then the comparison. Without a second
 * reading (a stored first reading, an old cache) every eligible line is held: one reading alone does not move money.
 */
export class AgreeingClassifier implements LineClassifier {
  constructor(
    private readonly inner: RawClassifier,
    /** Reads a disputed line's rows a third time; without it, a disputed line is asked of a person. */
    private readonly third?: ThirdReader,
  ) {}

  async classify(input: { receipt: ParsedReceipt; needs: Need[]; rules: string; second?: SecondReading; image?: ReceiptImage }) {
    const second: SecondReading = input.second ?? { receipt: null, lineBands: [], bandTexts: {}, bands: [], size: null, error: "no second reading was made" };
    const raw = await this.inner.classifyBoth({ receipt: input.receipt, second: second.receipt, needs: input.needs, rules: input.rules });
    let result = compareReadings({ receipt: input.receipt, second, needs: input.needs, raw });
    const usages = [raw.usage];
    // Recorded answers already carry the third readings (raw.third); a live run asks for the lines still disputed.
    if (!raw.third && result.asks.length && this.third && input.image) {
      const answers: Record<string, Line | null> = {};
      for (const ask of result.asks.slice(0, MAX_THIRD)) {
        try {
          const r = await this.third.readLine(input.image, second.bands.filter((b) => ask.bandIndexes.includes(b.index)), input.receipt.currency);
          answers[String(ask.lineNo)] = r.line;
          usages.push(r.usage);
        } catch (e) {
          answers[String(ask.lineNo)] = null; // a failed third reading decides nothing: the line stays with a person
          const u = (e as { usage?: ModelUsage }).usage;
          if (u) usages.push(u);
        }
      }
      result = compareReadings({ receipt: input.receipt, second, needs: input.needs, raw: { ...raw, third: answers } });
    }
    return { lines: result.lines, usage: sumUsage(usages), agreement: result.agreement };
  }
}

/** At most this many disputed lines of one receipt are read a third time. */
export const MAX_THIRD = 4;

export interface ThirdReader {
  readLine(image: ReceiptImage, bands: Band[], currency: string): Promise<{ line: Line | null; usage: ModelUsage }>;
}

/** Muse Spark reads the cut-out rows of one line, enlarged: one LINE row back. */
export class MetaThirdReader implements ThirdReader {
  constructor(private readonly o: MetaOptions) {}

  async readLine(image: ReceiptImage, bands: Band[], currency: string) {
    const what = "read C (one disputed line)";
    const cut = cutRows(image, bands);
    const { text, usage } = await metaRespond(this.o, { what, instructions: READ_C_SYSTEM, parts: [{ type: "input_text", text: `Currency: ${currency}.` }, imagePart(cut)] });
    return { line: parseThird(text, currency), usage };
  }
}

/** The third reading's one LINE row as a receipt line (lineNo 1), or null when it gives no amount. */
export function parseThird(answer: string, currency: string): Line | null {
  const row = answer
    .split(/\r?\n/)
    .map((r) => r.replace(/^[\s*•-]+/, "").trim())
    .map((r) => r.match(/^LINE\s*:\s*(.*)$/i)?.[1])
    .find((r) => r !== undefined);
  if (!row) return null;
  const f = kv(row, ["qty", "unit", "amount", "text", "en"]) ?? {};
  const exp = currency === "JPY" ? 0 : 2;
  const amount = minorUnits(f.amount, exp);
  const unit = minorUnits(f.unit, exp);
  const qty = EMPTY.has((f.qty ?? "").trim().toLowerCase()) ? null : Number(f.qty);
  if (typeof amount !== "number" || (unit !== null && typeof unit !== "number") || (qty !== null && !Number.isFinite(qty))) return null;
  return { lineNo: 1, rawText: (f.text ?? "").trim(), translationEn: (f.en ?? "").trim(), qty, unitPriceMinor: unit, amountMinor: amount, taxRateBp: null };
}

/** Replays stored raw classifications (keyed like RecordedClassifier) so the comparison can be re-run without a model. */
export class RecordedRawClassifier implements RawClassifier {
  constructor(private readonly byKey: (receipt: ParsedReceipt) => { first: LineClassification[]; second: LineClassification[]; third?: Record<string, Line | null> } | undefined) {}
  async classifyBoth(input: { receipt: ParsedReceipt }): Promise<RawClassification> {
    const r = this.byKey(input.receipt);
    if (!r) throw new Error("no recorded raw classification for this reading");
    return { first: structuredClone(r.first), second: structuredClone(r.second), ...(r.third ? { third: structuredClone(r.third) } : {}), usage: { model: "recorded", tokensIn: 0, tokensOut: 0, usdCeiling: 0, usdActual: 0 } };
  }
}
