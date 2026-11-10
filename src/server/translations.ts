import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { lineTranslations } from "../db/schema";
import { META_READ_MODEL } from "../receipts/meta";
import { SpendCap } from "../receipts/spend";
import { donorLang, translateLines, TRANSLATE_MAX_LINES, TRANSLATE_PREFIX, type DonorLang, type LineToTranslate } from "../receipts/translate";
import type { DriveView } from "./service";
import { PgMetaReadLedger } from "./spend";

// The donor's statement shows each receipt line in the donor's language. Where a translation comes from, in order:
// the recorded ones in the repo (the showcase and the sample receipt: never a call), the table of translations made
// before, then one call to Meta for the rest of that receipt's lines, inside the Meta reading's ceiling and ledger.
// Anything that fails leaves those lines in the reading's English, said so; a figure never depends on a translation.

export interface RecordedTranslations {
  lines: Partial<Record<DonorLang, Record<string, string>>>;
}

export interface TranslatedLine {
  receiptId: string;
  lineNo: number;
  text: string;
  /** recorded: the repo's file; kept: translated before; model: just now; english: the reading's English (nothing else). */
  source: "recorded" | "kept" | "model" | "english";
}

export interface StatementTranslation {
  lang: DonorLang;
  lines: TranslatedLine[];
  /** Some lines are in English because the donor's language could not be had (no key, ceiling reached, a bad answer). */
  unavailable: boolean;
}

export interface TranslatorDeps {
  db: Db;
  recorded: RecordedTranslations;
  /** Live translation by Meta: the reading's key and ceiling (READ_META_ALLOWED=yes); absent, nothing is called. */
  meta?: { apiKey: string; baseUrl?: string; capUsd: number; fetch?: typeof fetch };
  now?: () => Date;
  log?: (msg: string) => void;
}

type Wanted = LineToTranslate & { receiptId: string };

export class LineTranslator {
  private readonly inFlight = new Map<string, Promise<Map<number, string> | null>>();
  constructor(private readonly d: TranslatorDeps) {}

  /** The donor's lines on their statement, in their language (the hold's country decides it). */
  async forStatement(view: DriveView, pledgeId: string, rows: { receiptId: string; lineNo: number }[]): Promise<StatementTranslation> {
    const hold = view.holds.find((h) => h.pledgeId === pledgeId);
    const lang = donorLang(hold?.donorCountry ?? null);
    const wanted: Wanted[] = [];
    for (const key of new Set(rows.map((r) => `${r.receiptId}\u0000${r.lineNo}`))) {
      const [receiptId, n] = key.split("\u0000");
      const line = view.receipts.find((x) => x.id === receiptId)?.lines.find((l) => l.lineNo === Number(n));
      if (line) wanted.push({ receiptId, lineNo: line.lineNo, printed: (line.text ?? "").trim(), english: (line.translationEn ?? "").trim() || (line.text ?? "").trim() });
    }
    return this.translate(lang, wanted);
  }

  async translate(lang: DonorLang, wanted: Wanted[]): Promise<StatementTranslation> {
    const english = (l: Wanted): TranslatedLine => ({ receiptId: l.receiptId, lineNo: l.lineNo, text: l.english, source: "english" });
    if (lang === "en") return { lang, lines: wanted.map(english), unavailable: false };
    const out = new Map<string, TranslatedLine>();
    const id = (l: { receiptId: string; lineNo: number }) => `${l.receiptId}:${l.lineNo}`;
    const recorded = this.d.recorded.lines[lang] ?? {};
    for (const l of wanted) if (recorded[l.printed]) out.set(id(l), { receiptId: l.receiptId, lineNo: l.lineNo, text: recorded[l.printed], source: "recorded" });
    let unavailable = false;
    const byReceipt = new Map<string, Wanted[]>();
    for (const l of wanted) if (!out.has(id(l))) byReceipt.set(l.receiptId, [...(byReceipt.get(l.receiptId) ?? []), l]);
    for (const [receiptId, lines] of byReceipt) {
      const kept = await this.d.db
        .select({ lineNo: lineTranslations.lineNo, text: lineTranslations.text })
        .from(lineTranslations)
        .where(and(eq(lineTranslations.receiptId, receiptId), eq(lineTranslations.lang, lang), inArray(lineTranslations.lineNo, lines.map((l) => l.lineNo))));
      for (const k of kept) out.set(`${receiptId}:${k.lineNo}`, { receiptId, lineNo: k.lineNo, text: k.text, source: "kept" });
      const rest = lines.filter((l) => !out.has(id(l))).slice(0, TRANSLATE_MAX_LINES);
      if (!rest.length) continue;
      const made = await this.call(receiptId, lang, rest);
      if (!made) {
        unavailable = true;
        continue;
      }
      for (const l of rest) {
        const text = made.get(l.lineNo);
        if (text) out.set(id(l), { receiptId, lineNo: l.lineNo, text, source: "model" });
      }
    }
    const lines = wanted.map((l) => out.get(id(l)) ?? english(l));
    return { lang, lines, unavailable: unavailable || lines.some((l) => l.source === "english") };
  }

  /** One call per receipt and language at a time; null when there is no live translation or it failed. */
  private call(receiptId: string, lang: Exclude<DonorLang, "en">, lines: Wanted[]): Promise<Map<number, string> | null> {
    const meta = this.d.meta;
    if (!meta) return Promise.resolve(null);
    const key = `${receiptId}:${lang}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = (async () => {
      try {
        const cap = new SpendCap(new PgMetaReadLedger(this.d.db, meta.capUsd), meta.capUsd, this.d.now);
        const made = await translateLines({ apiKey: meta.apiKey, baseUrl: meta.baseUrl, fetch: meta.fetch, cap, prefix: TRANSLATE_PREFIX }, { what: receiptId, lang, lines });
        const at = (this.d.now?.() ?? new Date()).toISOString();
        const rows = [...made].map(([lineNo, text]) => ({ receiptId, lineNo, lang, text, model: META_READ_MODEL, at }));
        if (rows.length) await this.d.db.insert(lineTranslations).values(rows).onConflictDoNothing();
        return made;
      } catch (e) {
        this.d.log?.(`[translate] ${receiptId} ${lang}: ${(e as Error).message}`);
        return null;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return p;
  }
}
