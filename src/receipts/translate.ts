// A receipt's lines in a donor's language: one text-only call to Meta's Muse Spark (the reading's client, its spend cap
// and its ledger rows), the lines in, one short line out for each. Nothing here runs a live call by itself: the caller
// passes the options (the key, the cap, the fetch), and the tests a fake fetch.

import { metaRespond, type MetaOptions } from "./meta";
import { ModelOutputError } from "./wire";

export type DonorLang = "en" | "de" | "ja";
export const TRANSLATED: readonly DonorLang[] = ["de", "ja"];

/** The donor's language from the country PayPal gave for them: German- and Japanese-speaking countries; English otherwise. */
export function donorLang(country: string | null | undefined): DonorLang {
  const c = (country ?? "").toUpperCase();
  if (c === "DE" || c === "AT" || c === "CH" || c === "LI") return "de";
  if (c === "JP") return "ja";
  return "en";
}

export interface LineToTranslate {
  lineNo: number;
  /** As printed on the receipt. */
  printed: string;
  /** The reading's English for it. */
  english: string;
}

/** Every ledger row of a translation starts with this: inside the Meta reading's ceiling (META_READ_PREFIX), on its own line. */
export const TRANSLATE_PREFIX = "read-meta:translate:";
/** Enough for ~40 short lines and Muse Spark's reasoning. */
export const TRANSLATE_MAX_OUTPUT = 3000;
export const TRANSLATE_MAX_LINES = 40;

const NAME: Record<Exclude<DonorLang, "en">, string> = { de: "German", ja: "Japanese" };

export function translateInstructions(lang: Exclude<DonorLang, "en">): string {
  return [
    `You translate lines of a shop receipt into ${NAME[lang]} for the person whose money paid for them.`,
    "Each line: what was bought, as a shopper would say it, short (at most 8 words). Write brand names in Latin letters as in the English translation; keep sizes, counts and units; translate everything else.",
    "Do not add prices, explanations or anything that is not on the line.",
    'Answer with JSON only: {"lines":[{"n":<line number>,"t":"<translation>"}]}, one entry for every line you were given, in the same order.',
  ].join("\n");
}

export function translateInput(lines: LineToTranslate[]): string {
  return JSON.stringify({ lines: lines.map((l) => ({ n: l.lineNo, printed: l.printed, english: l.english })) });
}

/** The model's answer as line number -> text; refuses an answer that leaves out a line, adds one, or is not JSON. */
export function parseTranslations(text: string, lines: LineToTranslate[]): Map<number, string> {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ModelOutputError(`translation: the answer is not JSON: ${text.slice(0, 200)}`);
  }
  const got = (parsed as { lines?: { n?: unknown; t?: unknown }[] }).lines;
  if (!Array.isArray(got)) throw new ModelOutputError("translation: the answer has no lines");
  const out = new Map<number, string>();
  for (const g of got) {
    const n = Number(g.n);
    const t = typeof g.t === "string" ? g.t.trim() : "";
    if (!lines.some((l) => l.lineNo === n)) throw new ModelOutputError(`translation: line ${String(g.n)} was not asked for`);
    if (!t) throw new ModelOutputError(`translation: line ${n} came back empty`);
    out.set(n, t.slice(0, 160));
  }
  const missing = lines.filter((l) => !out.has(l.lineNo)).map((l) => l.lineNo);
  if (missing.length) throw new ModelOutputError(`translation: lines ${missing.join(", ")} came back missing`);
  return out;
}

/** One call for the lines of one receipt into one language. `what` names the ledger row after the prefix. */
export async function translateLines(o: MetaOptions, args: { what: string; lang: Exclude<DonorLang, "en">; lines: LineToTranslate[] }): Promise<Map<number, string>> {
  if (!args.lines.length) return new Map();
  if (args.lines.length > TRANSLATE_MAX_LINES) throw new Error(`translation: ${args.lines.length} lines, at most ${TRANSLATE_MAX_LINES} in one call`);
  const { text } = await metaRespond(
    { ...o, maxOutputTokens: o.maxOutputTokens ?? TRANSLATE_MAX_OUTPUT },
    { what: `${args.what} ${args.lang}`, instructions: translateInstructions(args.lang), parts: [{ type: "input_text", text: translateInput(args.lines) }] },
  );
  return parseTranslations(text, args.lines);
}
