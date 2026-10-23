import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import type { CurrencyCode, Need } from "../core/types";
import { BedrockNovaClassifier, BedrockNovaReader, ModelOutputError, type ConverseClient } from "../receipts/bedrock";
import { receiptKey, RecordedClassifier, RecordedReader, type Recordings } from "../receipts/recorded";
import { SpendCap, SpendCapExceeded } from "../receipts/spend";
import type { LineClassification, ModelUsage, ParsedReceipt, ReceiptImage } from "../receipts/types";
import { ServiceError } from "./errors";
import { PgSpendLedger } from "./spend";

// Where a receipt's reading comes from, cheapest first:
//   1. the same photo already in this drive (it will be flagged as a duplicate),
//   2. the recorded answers shipped with the app (eval/receipts/recorded.json),
//   3. a live answer stored for the same photo in another drive,
//   4. a live Nova call, under the per-IP daily limit and the $5 spend cap.

export type ReaderSource = "copy" | "recorded" | "nova";

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
  constructor(
    private readonly db: Db,
    private readonly recordings: Recordings,
    private readonly limits: LiveLimits,
    private readonly bedrock?: () => ConverseClient,
  ) {}

  async read(input: ReadInput): Promise<Reading> {
    const sameSha = await this.db
      .select({ driveId: receipts.driveId, parsed: receipts.parsed, classified: receipts.classified, reader: receipts.reader })
      .from(receipts)
      .where(and(eq(receipts.sha256, input.sha256), isNotNull(receipts.parsed)))
      .orderBy(asc(receipts.uploadedAt));

    const own = sameSha.find((r) => r.driveId === input.driveId);
    if (own) return { parsed: own.parsed as ParsedReceipt, classified: own.classified as StoredClassification, reader: "copy", usage: [] };

    const key = (p: ParsedReceipt) => classificationKey(p, input.needs, input.rules);

    if (Object.hasOwn(this.recordings.readings, input.sha256)) {
      const { receipt: parsed } = await new RecordedReader(this.recordings).read(input.image);
      if (Object.hasOwn(this.recordings.classifications, receiptKey(parsed))) {
        const { lines } = await new RecordedClassifier(this.recordings).classify({ receipt: parsed, needs: input.needs, rules: input.rules });
        return { parsed, classified: { key: key(parsed), lines }, reader: "recorded", usage: [] };
      }
      return this.classifyLive(input, parsed, []);
    }

    const cached = sameSha.find((r) => r.reader === "nova" || r.reader === "copy");
    if (cached) {
      const parsed = cached.parsed as ParsedReceipt;
      const stored = cached.classified as StoredClassification | null;
      if (stored && stored.key === key(parsed)) return { parsed, classified: stored, reader: "copy", usage: [] };
      return this.classifyLive(input, parsed, []);
    }

    const models = await this.liveModels(input);
    const { receipt: parsed, usage } = await this.guard(() =>
      models.reader.read(input.image, { currency: input.baseCurrency, languages: LANGUAGES[input.baseCurrency] ?? ["en"] }),
    );
    return this.classifyLive(input, parsed, [usage], models);
  }

  /** Any model call makes the reading "nova", so it counts against the per-IP live limit. */
  private async classifyLive(input: ReadInput, parsed: ParsedReceipt, usage: ModelUsage[], models?: { classifier: BedrockNovaClassifier }): Promise<Reading> {
    const m = models ?? (await this.liveModels(input));
    const { lines, usage: u } = await this.guard(() => m.classifier.classify({ receipt: parsed, needs: input.needs, rules: input.rules }));
    return { parsed, classified: { key: classificationKey(parsed, input.needs, input.rules), lines }, reader: "nova", usage: [...usage, u] };
  }

  /** Refuses before any model call when live reading is off or a limit is reached. */
  private async liveModels(input: ReadInput): Promise<{ reader: BedrockNovaReader; classifier: BedrockNovaClassifier }> {
    if (!this.bedrock) {
      throw new ServiceError(503, "live_reading_off", "Live receipt reading is not switched on for this server. Use the sample receipt.", SAMPLE_HINT);
    }
    const since = new Date(Date.parse(input.now) - 24 * 3_600_000).toISOString();
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.ipHash, input.ipHash), eq(receipts.reader, "nova"), gt(receipts.uploadedAt, since)));
    if (row.n >= this.limits.liveReadsPerDay) {
      throw new ServiceError(
        429,
        "live_limit",
        `This network has used its ${this.limits.liveReadsPerDay} live receipt readings for today. Try again tomorrow, or use the sample receipt.`,
        SAMPLE_HINT,
      );
    }
    const client = this.bedrock();
    const cap = new SpendCap(new PgSpendLedger(this.db), this.limits.spendCapUsd);
    return { reader: new BedrockNovaReader({ client, cap }), classifier: new BedrockNovaClassifier({ client, cap }) };
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
