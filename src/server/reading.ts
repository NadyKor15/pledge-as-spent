import { z } from "zod";
import { and, asc, eq, gt, isNotNull, like, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import type { CurrencyCode, Need } from "../core/types";
import { closeReceipt } from "../receipts/close";
import { hammingHex } from "../receipts/hash";
import { uprightImage } from "../receipts/orient";
import { classificationKey, receiptKey, RecordedClassifier, RecordedReader, type Recordings } from "../receipts/recorded";
import { SpendCap, SpendCapExceeded } from "../receipts/spend";
import { AgreeingClassifier, MetaRawClassifier, MetaThirdReader, MetaTwoReadings } from "../receipts/meta-reader";
import { ModelOutputError } from "../receipts/wire";
import { Band, LineBox, LineClassification, ParsedReceipt, type LineClassifier, type ModelUsage, type PurchaseLine, type ReceiptImage, type ReceiptReader, type SecondReading } from "../receipts/types";
import heroAnswer from "../../eval/live/shipped/hero-ja-01.meta.json";
import floridaRealAnswer from "../../eval/live/shipped/florida-real-2019.meta.json";
import floridaRows from "../../eval/live/shipped/florida-sample.bands.json";
import { ServiceError } from "./errors";
import { META_READ_PREFIX, PgMetaReadLedger } from "./spend";

// Where a receipt's reading comes from, cheapest first:
//   1. the same photo already in this drive (it will be flagged as a duplicate)          reader "copy"
//   2. a saved answer of a real pipeline run shipped with the app (the sample receipt)  reader "cached:<pipeline>"
//   3. recorded answers (tests only: the receipts' truth files)                         reader "recorded"
//   4. a live answer stored for the same photo in another drive                        reader "copy"
//   5. the live pipeline, under the per-IP daily limit and Meta reading's own ceiling   reader "live:<pipeline>"
// With live reading on, 2-4 are used only when complete (an answer for these needs, and from 4 its rows too);
// anything less is read live from the start, never classified on one reading.

/**
 * The live pipeline (src/receipts): Meta's Muse Spark reads the photo twice (the whole photo, and the numbered rows
 * code cut out by pixels) and a line passes only when both readings agree.
 */
export type Pipeline = "meta";
export const PIPELINES: readonly Pipeline[] = ["meta"];

export type ReaderSource = "copy" | "recorded" | `cached:${string}` | `recognized:${string}` | `live:${Pipeline}`;

/**
 * How far, in bits of 256, a photo may look from the shipped sample and still be taken for it. Recompressed copies
 * sit at 4-7 bits and the nearest other receipt of 63 at 59 (tests/app/sample-recognition.test.ts holds both).
 */
export const SAMPLE_MAX_DISTANCE = 16;

export interface StoredClassification {
  /** Hash of the parsed receipt + the drive's needs and rules the lines were matched against. */
  key: string;
  lines: LineClassification[];
}

export interface Reading {
  parsed: ParsedReceipt;
  classified: StoredClassification;
  reader: ReaderSource;
  usage: ModelUsage[];
  /** Where each line is printed on the photo, when the reader saw it (OCR, pixel bands) or a saved answer carries it. */
  lineBoxes?: LineBox[];
  /** The Meta pipeline: the printed rows found by pixels, the second reading's text of each, and the rows of each purchase line. */
  bands?: Band[];
  bandTexts?: Record<string, string>;
  purchaseLines?: PurchaseLine[];
  /**
   * The closed copy of the photo (only the purchase lines' rows open), when the reading knows its rows: the only copy
   * that may be published. null: it could not be made, so nothing is published. Absent: an older reading.
   */
  closed?: Uint8Array | null;
}

/** Closes a photo by its rows: every pixel outside the open rows of the purchase lines becomes plain background. */
export type CloseReceipt = (image: ReceiptImage, bands: Band[], purchaseLines: PurchaseLine[]) => Uint8Array | null;

/** What a stored reading keeps beside it, in the receipt's checks: rows and boxes, never written by a model. */
const RowsKept = z.object({
  lineBoxes: z.array(LineBox).optional(),
  bands: z.array(Band).optional(),
  bandTexts: z.record(z.string(), z.string()).optional(),
  purchaseLines: z.array(z.object({ lineNo: z.number().int().positive(), bandIndexes: z.array(z.number().int().positive()) })).optional(),
});

export interface LiveLimits {
  liveReadsPerDay: number;
  /** A live reading that takes longer ends in a plain answer, not a hung request. */
  liveReadMs: number;
}

class ReadingTimeout extends Error {}

export interface LiveReading {
  pipeline: Pipeline;
  /** The author's Meta Model API key and the reading's own ceiling (never above META_READ_CAP_MAX_USD). */
  meta?: { apiKey: string; baseUrl?: string; capUsd: number; fetch?: typeof fetch };
}

/** A real pipeline's saved answer for one photo (a copy of eval/live/<pipeline>/<receipt>.json in eval/live/shipped/, so a new benchmark run does not change the demo). Never a hand-written reading. */
export interface SavedAnswer {
  pipeline: string;
  imageSha256: string;
  /** Perceptual hash of the same photo: messengers recompress it, so its bytes do not survive the trip. */
  imageDHash?: string;
  reading: ParsedReceipt;
  classifications: LineClassification[];
  /** classificationKey of the run: the lines were matched against these needs and rules, and no others. */
  classifiedFor: string;
  /** Where its lines are printed: from its pixel bands. */
  lineBoxes?: LineBox[];
  /** The Meta pipeline's rows, kept so the published copy is closed the same way as a live reading's. */
  bands?: Band[];
  bandTexts?: Record<string, string>;
  purchaseLines?: PurchaseLine[];
}

const SavedFile = z.object({
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  imageDHash: z.string().optional(),
  reading: ParsedReceipt,
  classifications: z.array(LineClassification),
  classifiedFor: z.string(),
  lineBoxes: z.array(LineBox).optional(),
  bands: z.array(Band).optional(),
  bandTexts: z.record(z.string(), z.string()).optional(),
  purchaseLines: z.array(z.object({ lineNo: z.number().int().positive(), bandIndexes: z.array(z.number().int().positive()) })).optional(),
});

const BoxesFile = z.object({ imageSha256: z.string().regex(/^[0-9a-f]{64}$/), lineBoxes: z.array(LineBox) });

/** `boxes`: line boxes measured on the same photo (boxes of another photo are refused); rows come in the answer itself. */
export function savedAnswer(json: unknown, pipeline: string, boxes?: unknown): SavedAnswer {
  const f = SavedFile.parse(json);
  const b = boxes === undefined ? null : BoxesFile.parse(boxes);
  if (b && b.imageSha256 !== f.imageSha256) throw new Error("The line boxes were measured on another photo.");
  const boxesOwn = f.lineBoxes ? { lineBoxes: f.lineBoxes } : {};
  const rows = f.bands && f.purchaseLines ? { bands: f.bands, bandTexts: f.bandTexts ?? {}, purchaseLines: f.purchaseLines } : {};
  return { pipeline, imageSha256: f.imageSha256, imageDHash: f.imageDHash, reading: f.reading, classifications: f.classifications, classifiedFor: f.classifiedFor, ...boxesOwn, ...(b ? { lineBoxes: b.lineBoxes } : {}), ...rows };
}

/**
 * The sample receipt's reading: what Meta's two readings really answered on that photo in the benchmark's live run
 * (tools/receipts/ship-meta.ts), not its truth file. Its rows close the published copy as a live reading's would.
 * The Florida drive's real receipt (florida-real) is Meta's live reading of the original photo, kept with the closed copy
 * that is the only image in the repository (tools/receipts/read-private.ts, ship-private.ts).
 */
export const SHIPPED_ANSWERS: SavedAnswer[] = [savedAnswer(heroAnswer, "meta"), savedAnswer(floridaRealAnswer, "meta")];

const RowsFile = z.object({
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bands: z.array(Band),
  purchaseLines: z.array(z.object({ lineNo: z.number().int().positive(), bandIndexes: z.array(z.number().int().positive()) })),
});
export type ShippedRows = z.infer<typeof RowsFile>;

/**
 * Rows of a sample whose reading is the recorded one (the Florida drive's sample, a copy of a synthetic receipt):
 * measured on the photo from its generator's truth (tools/receipts/sample-bands.ts), so its published copy is closed
 * by them like any reading's. Only the same bytes get them.
 */
export const SHIPPED_ROWS: ShippedRows[] = [RowsFile.parse(floridaRows)];

export interface ReadInput {
  driveId: string;
  image: ReceiptImage;
  sha256: string;
  needs: Need[];
  rules: string;
  baseCurrency: CurrencyCode;
  ipHash: string;
  now: string;
  /** Demo drives only: a recompressed copy of the shipped sample gets its saved reading, and says so. */
  sampleLook?: string | null;
}

export const SAMPLE_HINT = {
  sample: {
    field: "sample",
    value: "hero",
    description: "Upload the sample receipt instead (form field sample=hero): its reading is cached, no model call.",
  },
};

const LANGUAGES: Partial<Record<CurrencyCode, string[]>> = { JPY: ["ja", "en"], EUR: ["es", "en"], USD: ["en"] };

export { classificationKey };

export class ReceiptReading {
  private readonly answers: Map<string, SavedAnswer>;

  constructor(
    private readonly db: Db,
    sources: { answers?: SavedAnswer[]; recordings?: Recordings; rows?: ShippedRows[] },
    private readonly limits: LiveLimits,
    private readonly live?: LiveReading,
    /** Closes the published copy by rows (src/receipts/close.ts); a test may hand in its own. */
    private readonly close: CloseReceipt = closeReceipt,
  ) {
    this.answers = new Map((sources.answers ?? SHIPPED_ANSWERS).map((a) => [a.imageSha256, a]));
    this.recordings = sources.recordings ?? { readings: {}, classifications: {} };
    this.rows = new Map((sources.rows ?? SHIPPED_ROWS).map((r) => [r.imageSha256, r]));
  }
  private readonly recordings: Recordings;
  private readonly rows: Map<string, ShippedRows>;

  async read(input: ReadInput): Promise<Reading> {
    // A phone photo turned by its EXIF tag is made upright once: the readers, the rows and the closed copy all use it.
    input = { ...input, image: uprightImage(input.image) };
    const sameSha = await this.db
      .select({ driveId: receipts.driveId, parsed: receipts.parsed, classified: receipts.classified, reader: receipts.reader, checks: receipts.checks })
      .from(receipts)
      .where(and(eq(receipts.sha256, input.sha256), isNotNull(receipts.parsed)))
      .orderBy(asc(receipts.uploadedAt));

    // The same photo keeps the boxes and rows its first reading found, and is closed by them again.
    const boxesOf = (checks: unknown): Pick<Reading, "lineBoxes" | "bands" | "bandTexts" | "purchaseLines" | "closed"> => {
      const kept = RowsKept.safeParse(checks ?? {});
      if (!kept.success) return {};
      const k = kept.data;
      return {
        ...(k.lineBoxes?.length ? { lineBoxes: k.lineBoxes } : {}),
        ...(k.bands && k.purchaseLines ? this.rowsOf(input.image, k.bands, k.bandTexts ?? {}, k.purchaseLines) : {}),
      };
    };
    const own = sameSha.find((r) => r.driveId === input.driveId);
    if (own) return { parsed: own.parsed as ParsedReceipt, classified: own.classified as StoredClassification, reader: "copy", usage: [], ...boxesOf(own.checks) };

    const key = (p: ParsedReceipt) => classificationKey(p, input.needs, input.rules);
    // Meta passes a line only when its two readings agree. A reading kept without its second one (a recording with no
    // recorded classification, a stored reading of another pipeline or for other needs) is not classified alone on
    // that path: the photo is read twice, as a new one is. A kept answer that is complete is still used as it is.
    const twoReadings = this.live?.pipeline === "meta";

    const look = input.sampleLook;
    const exact = this.answers.get(input.sha256);
    const saved = exact ?? (look ? [...this.answers.values()].find((a) => a.imageDHash && hammingHex(a.imageDHash, look) <= SAMPLE_MAX_DISTANCE) : undefined);
    if (saved) {
      const parsed = structuredClone(saved.reading);
      // Boxes were measured on the saved photo's own pixels: only the same bytes get them, not a look-alike.
      const boxes = {
        ...(exact && saved.lineBoxes ? { lineBoxes: structuredClone(saved.lineBoxes) } : {}),
        ...(exact && saved.bands && saved.purchaseLines ? this.rowsOf(input.image, saved.bands, saved.bandTexts ?? {}, saved.purchaseLines) : {}),
      };
      if (key(parsed) !== saved.classifiedFor) {
        if (twoReadings) return this.readLive(input);
        return { ...(await this.classifyLive(input, parsed, [])), ...boxes };
      }
      return { parsed, classified: { key: saved.classifiedFor, lines: structuredClone(saved.classifications) }, reader: `${exact ? "cached" : "recognized"}:${saved.pipeline}`, usage: [], ...boxes };
    }

    if (Object.hasOwn(this.recordings.readings, input.sha256)) {
      const { receipt: parsed } = await new RecordedReader(this.recordings).read(input.image);
      const shipped = this.rows.get(input.sha256);
      const rows = shipped ? this.rowsOf(input.image, shipped.bands, {}, shipped.purchaseLines) : {};
      if (Object.hasOwn(this.recordings.classifications, receiptKey(parsed))) {
        const { lines } = await new RecordedClassifier(this.recordings).classify({ receipt: parsed, needs: input.needs, rules: input.rules });
        return { parsed, classified: { key: key(parsed), lines }, reader: "recorded", usage: [], ...rows };
      }
      if (twoReadings) return this.readLive(input);
      return { ...(await this.classifyLive(input, parsed, [])), ...rows };
    }

    const reusable = sameSha.filter((r) => r.reader.startsWith("live:") || r.reader === "copy");
    // On Meta's path the oldest reading that kept its rows, so one row-less older reading does not cost every new drive a live one.
    const stored = (twoReadings ? reusable.find((r) => RowsKept.safeParse(r.checks ?? {}).data?.purchaseLines) : undefined) ?? reusable[0];
    if (stored) {
      const parsed = stored.parsed as ParsedReceipt;
      const cls = stored.classified as StoredClassification | null;
      const kept = boxesOf(stored.checks);
      // On Meta's path only a two-reading answer is copied: it carries the rows that close the published photo.
      const complete = !twoReadings || (kept.bands !== undefined && kept.purchaseLines !== undefined);
      if (cls && cls.key === key(parsed) && complete) return { parsed, classified: cls, reader: "copy", usage: [], ...kept };
      if (twoReadings) return this.readLive(input);
      return { ...(await this.classifyLive(input, parsed, [])), ...kept };
    }

    return this.readLive(input);
  }

  /** A new photo: the live pipeline reads it (Meta: both readings, the rows, the agreement, the closed copy). */
  private async readLive(input: ReadInput): Promise<Reading> {
    const models = await this.liveModels(input);
    const { receipt: parsed, usage, lineBoxes, second } = await this.guard(() =>
      models.reader.read(input.image, { currency: input.baseCurrency, languages: LANGUAGES[input.baseCurrency] ?? ["en"] }),
    );
    return { ...(lineBoxes?.length ? { lineBoxes } : {}), ...(await this.classifyLive(input, parsed, [usage], models, second)) };
  }

  /** The rows a reading keeps, and the photo closed by them (null when it cannot be closed: then nothing is published). */
  private rowsOf(image: ReceiptImage, bands: Band[], bandTexts: Record<string, string>, purchaseLines: PurchaseLine[]): Pick<Reading, "bands" | "bandTexts" | "purchaseLines" | "closed"> {
    let closed: Uint8Array | null = null;
    try {
      closed = this.close(image, bands, purchaseLines);
    } catch {
      closed = null; // closed by default: a copy that could not be closed is not published
    }
    return { bands: structuredClone(bands), bandTexts: { ...bandTexts }, purchaseLines: structuredClone(purchaseLines), closed };
  }

  /** Any model call makes the reading "live:<pipeline>", so it counts against the per-IP live limit. */
  private async classifyLive(input: ReadInput, parsed: ParsedReceipt, usage: ModelUsage[], models?: { classifier: LineClassifier; pipeline: Pipeline }, second?: SecondReading): Promise<Reading> {
    const m = models ?? (await this.liveModels(input));
    const { lines, usage: u, agreement } = await this.guard(() => m.classifier.classify({ receipt: parsed, needs: input.needs, rules: input.rules, image: input.image, ...(second ? { second } : {}) }));
    const rows = second && agreement ? { ...this.rowsOf(input.image, second.bands, second.bandTexts, agreement.purchaseLines), ...(agreement.lineBoxes.length ? { lineBoxes: agreement.lineBoxes } : {}) } : {};
    return { parsed, classified: { key: classificationKey(parsed, input.needs, input.rules), lines }, reader: `live:${m.pipeline}`, usage: [...usage, u], ...rows };
  }

  /** Refuses before any model call when live reading is off or a limit is reached. */
  private async liveModels(input: ReadInput): Promise<{ reader: ReceiptReader; classifier: LineClassifier; pipeline: Pipeline }> {
    if (!this.live) {
      throw new ServiceError(503, "live_reading_off", "Live receipt reading is not switched on for this server. Use the sample receipt.", SAMPLE_HINT);
    }
    const since = new Date(Date.parse(input.now) - 24 * 3_600_000).toISOString();
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.ipHash, input.ipHash), like(receipts.reader, "live:%"), gt(receipts.uploadedAt, since)));
    if (row.n >= this.limits.liveReadsPerDay) {
      throw new ServiceError(
        429,
        "live_limit",
        `This network has used its ${this.limits.liveReadsPerDay} live receipt readings for today. Try again tomorrow, or use the sample receipt.`,
        SAMPLE_HINT,
      );
    }
    const { pipeline, meta } = this.live;
    if (!meta || !(meta.capUsd > 0)) throw new ServiceError(503, "live_reading_off", "Live receipt reading by Meta is not switched on for this server. Use the sample receipt.", SAMPLE_HINT);
    const ledger = new PgMetaReadLedger(this.db, meta.capUsd);
    const o = { apiKey: meta.apiKey, cap: new SpendCap(ledger, ledger.capUsd), prefix: META_READ_PREFIX, ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}), ...(meta.fetch ? { fetch: meta.fetch } : {}), timeoutMs: Math.max(10_000, this.limits.liveReadMs - 5_000) };
    return { reader: new MetaTwoReadings(o), classifier: new AgreeingClassifier(new MetaRawClassifier(o), new MetaThirdReader(o)), pipeline };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadingTimeout()), this.limits.liveReadMs);
    });
    try {
      return await Promise.race([fn(), deadline]);
    } catch (e) {
      if (e instanceof ReadingTimeout) {
        throw new ServiceError(503, "reading_timeout", "The receipt reader did not answer in time. Try again, or use the sample receipt.", SAMPLE_HINT);
      }
      if (e instanceof SpendCapExceeded) {
        throw new ServiceError(429, "spend_cap", "The demo's budget for live receipt reading is used up. Use the sample receipt.", SAMPLE_HINT);
      }
      if (e instanceof ModelOutputError) {
        throw new ServiceError(422, "unreadable_by_model", "The receipt could not be read. Please retake the photo flat, in good light.");
      }
      if (e instanceof Error && /^Meta answered \d{3}/.test(e.message)) {
        throw new ServiceError(503, "reader_unavailable", "The receipt reader is not answering right now. Try again, or use the sample receipt.", SAMPLE_HINT);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
