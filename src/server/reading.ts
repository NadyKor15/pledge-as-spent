import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, isNotNull, like, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import type { CurrencyCode, Need } from "../core/types";
import { BedrockNovaClassifier, BedrockNovaReader, ModelOutputError, NOVA_MODELS, type ConverseClient } from "../receipts/bedrock";
import { OcrNovaReader, type OcrEngine } from "../receipts/ocr";
import { receiptKey, RecordedClassifier, RecordedReader, type Recordings } from "../receipts/recorded";
import { SpendCap, SpendCapExceeded } from "../receipts/spend";
import { LineClassification, ParsedReceipt, type LineClassifier, type ModelUsage, type ReceiptImage, type ReceiptReader } from "../receipts/types";
import { ServiceError } from "./errors";
import { PgSpendLedger } from "./spend";

// Where a receipt's reading comes from, cheapest first:
//   1. the same photo already in this drive (it will be flagged as a duplicate)          reader "copy"
//   2. a saved answer of a real pipeline run shipped with the app (the sample receipt)  reader "cached:<pipeline>"
//   3. recorded answers (tests only: the receipts' truth files)                         reader "recorded"
//   4. a live answer stored for the same photo in another drive                        reader "copy"
//   5. the live pipeline, under the per-IP daily limit and the $5 spend cap            reader "live:<pipeline>"

/** Live pipelines (src/receipts): Tesseract OCR + Nova structuring, or Nova vision in one step. */
export type Pipeline = "ocr-lite" | "ocr-pro" | "nova-lite";
export const PIPELINES: readonly Pipeline[] = ["ocr-lite", "ocr-pro", "nova-lite"];

export type ReaderSource = "copy" | "recorded" | `cached:${string}` | `live:${Pipeline}`;

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
}

export interface LiveLimits {
  liveReadsPerDay: number;
  spendCapUsd: number;
}

export interface LiveReading {
  pipeline: Pipeline;
  bedrock: () => ConverseClient;
  /** The OCR engine for the ocr-* pipelines (Tesseract with the vendored traineddata). */
  ocr?: () => OcrEngine;
}

/** A real pipeline's saved answer for one photo (eval/live/<pipeline>/<receipt>.json). Never a hand-written reading. */
export interface SavedAnswer {
  pipeline: string;
  imageSha256: string;
  reading: ParsedReceipt;
  classifications: LineClassification[];
}

const SavedFile = z.object({ imageSha256: z.string().regex(/^[0-9a-f]{64}$/), reading: ParsedReceipt, classifications: z.array(LineClassification) });

export function savedAnswer(json: unknown, pipeline: string): SavedAnswer {
  const f = SavedFile.parse(json);
  return { pipeline, imageSha256: f.imageSha256, reading: f.reading, classifications: f.classifications };
}

export interface ReadInput {
  driveId: string;
  image: ReceiptImage;
  sha256: string;
  needs: Need[];
  rules: string;
  baseCurrency: CurrencyCode;
  ipHash: string;
  now: string;
}

export const SAMPLE_HINT = {
  sample: {
    field: "sample",
    value: "hero",
    description: "Upload the sample receipt instead (form field sample=hero): its reading is cached, no model call.",
  },
};

const LANGUAGES: Partial<Record<CurrencyCode, string[]>> = { JPY: ["ja", "en"], EUR: ["es", "en"], USD: ["en"] };

export function classificationKey(parsed: ParsedReceipt, needs: Need[], rules: string): string {
  const basis = JSON.stringify({
    receipt: receiptKey(parsed),
    needs: needs.map((n) => [n.id, n.label, n.unit, n.qtyNeeded]),
    rules,
  });
  return createHash("sha256").update(basis).digest("hex");
}

export class ReceiptReading {
  private readonly answers: Map<string, SavedAnswer>;

  constructor(
    private readonly db: Db,
    sources: { answers?: SavedAnswer[]; recordings?: Recordings },
    private readonly limits: LiveLimits,
    private readonly live?: LiveReading,
  ) {
    this.answers = new Map((sources.answers ?? []).map((a) => [a.imageSha256, a]));
    this.recordings = sources.recordings ?? { readings: {}, classifications: {} };
  }
  private readonly recordings: Recordings;

  async read(input: ReadInput): Promise<Reading> {
    const sameSha = await this.db
      .select({ driveId: receipts.driveId, parsed: receipts.parsed, classified: receipts.classified, reader: receipts.reader })
      .from(receipts)
      .where(and(eq(receipts.sha256, input.sha256), isNotNull(receipts.parsed)))
      .orderBy(asc(receipts.uploadedAt));

    const own = sameSha.find((r) => r.driveId === input.driveId);
    if (own) return { parsed: own.parsed as ParsedReceipt, classified: own.classified as StoredClassification, reader: "copy", usage: [] };

    const key = (p: ParsedReceipt) => classificationKey(p, input.needs, input.rules);

    const saved = this.answers.get(input.sha256);
    if (saved) {
      const parsed = structuredClone(saved.reading);
      return { parsed, classified: { key: key(parsed), lines: structuredClone(saved.classifications) }, reader: `cached:${saved.pipeline}`, usage: [] };
    }

    if (Object.hasOwn(this.recordings.readings, input.sha256)) {
      const { receipt: parsed } = await new RecordedReader(this.recordings).read(input.image);
      if (Object.hasOwn(this.recordings.classifications, receiptKey(parsed))) {
        const { lines } = await new RecordedClassifier(this.recordings).classify({ receipt: parsed, needs: input.needs, rules: input.rules });
        return { parsed, classified: { key: key(parsed), lines }, reader: "recorded", usage: [] };
      }
      return this.classifyLive(input, parsed, []);
    }

    const stored = sameSha.find((r) => r.reader.startsWith("live:") || r.reader === "copy");
    if (stored) {
      const parsed = stored.parsed as ParsedReceipt;
      const cls = stored.classified as StoredClassification | null;
      if (cls && cls.key === key(parsed)) return { parsed, classified: cls, reader: "copy", usage: [] };
      return this.classifyLive(input, parsed, []);
    }

    const models = await this.liveModels(input);
    const { receipt: parsed, usage } = await this.guard(() =>
      models.reader.read(input.image, { currency: input.baseCurrency, languages: LANGUAGES[input.baseCurrency] ?? ["en"] }),
    );
    return this.classifyLive(input, parsed, [usage], models);
  }

  /** Any model call makes the reading "live:<pipeline>", so it counts against the per-IP live limit. */
  private async classifyLive(input: ReadInput, parsed: ParsedReceipt, usage: ModelUsage[], models?: { classifier: LineClassifier; pipeline: Pipeline }): Promise<Reading> {
    const m = models ?? (await this.liveModels(input));
    const { lines, usage: u } = await this.guard(() => m.classifier.classify({ receipt: parsed, needs: input.needs, rules: input.rules }));
    return { parsed, classified: { key: classificationKey(parsed, input.needs, input.rules), lines }, reader: `live:${m.pipeline}`, usage: [...usage, u] };
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
    const { pipeline } = this.live;
    const client = this.live.bedrock();
    const cap = new SpendCap(new PgSpendLedger(this.db), this.limits.spendCapUsd);
    // As in the benchmark (tools/eval/run.ts): the classifier uses the pipeline's model size.
    const modelId = pipeline === "ocr-pro" ? NOVA_MODELS.pro : NOVA_MODELS.lite;
    const classifier = new BedrockNovaClassifier({ client, cap, modelId });
    if (pipeline === "nova-lite") return { reader: new BedrockNovaReader({ client, cap, modelId }), classifier, pipeline };
    if (!this.live.ocr) throw new ServiceError(503, "live_reading_off", "The OCR engine is not configured on this server. Use the sample receipt.", SAMPLE_HINT);
    return { reader: new OcrNovaReader({ client, cap, modelId, engine: this.live.ocr() }), classifier, pipeline };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SpendCapExceeded) {
        throw new ServiceError(429, "spend_cap", "The demo's budget for live receipt reading is used up. Use the sample receipt.", SAMPLE_HINT);
      }
      if (e instanceof ModelOutputError) {
        throw new ServiceError(422, "unreadable_by_model", "The receipt could not be read. Please retake the photo flat, in good light.");
      }
      throw e;
    }
  }
}
