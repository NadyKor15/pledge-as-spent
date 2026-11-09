import { extractClaims, type AgentLocale, type Claim } from "./money-parse";
import type { Fact } from "./types";

// "Numbers only from the book": an answer may state a figure only if a tool of the book returned
// it. The figures a delegate wrote in its summary do not count — a model wrote them. What the
// guard cannot place stops the answer; the caller asks the model once more or says so.

/** A model may write its reasoning in <thinking> tags; the reader never sees it and the guard ignores it. */
export function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*$/i, "") // cut off mid-thought by the output limit
    .replace(/<\/?response>/gi, "")
    .trim();
}

export { extractClaims };
export type { Claim };

/** Half a cent: the book's figures are exact in minor units, a written one is rounded at most to its last digit. */
const EPS = 0.005;

/** Whether one fact confirms one claim: an id letter for letter, money by value and currency, a share by value and topic. */
function confirms(claim: Claim, f: Fact): boolean {
  if (claim.kind === "id") return f.id !== undefined && f.id === claim.id;
  if (f.id !== undefined) return false;
  const v = claim.value!;
  if (claim.kind === "share") {
    // A share is confirmed only by a share of the same kind ("100 % taken by PayPal" is not "100 % back").
    if (f.unit !== "%") return false;
    if (claim.topic && f.topic && claim.topic !== f.topic) return false;
    return Math.abs(f.value - v) <= (claim.tolerance ?? 0.5);
  }
  if (f.unit === "%") return false;
  if (claim.currency) return f.currency === claim.currency && Math.abs(f.value - v) < EPS;
  return Math.abs(f.value - v) < EPS;
}

export function factFor(claim: Claim, facts: readonly Fact[]): Fact | undefined {
  return facts.find((f) => confirms(claim, f));
}

/** Every fact a claim matches (a figure can be a line's share and a need's total at once). */
export function factsFor(claim: Claim, facts: readonly Fact[]): Fact[] {
  return facts.filter((f) => confirms(claim, f));
}

/** The book lines behind a claim, for narrowing the book to them. */
export function linesFor(claim: Claim, facts: readonly Fact[]): string[] {
  return [...new Set(factsFor(claim, facts).flatMap((f) => [...(f.lineKeys ?? []), ...(f.lineKey ? [f.lineKey] : [])]))];
}

export interface Verdict {
  ok: boolean;
  /** Claims the book confirms, in the order they are written. */
  checked: Claim[];
  /** Claims nothing in the book returned. */
  unmatched: Claim[];
}

export function checkAnswer(text: string, facts: readonly Fact[], locale: AgentLocale = "en"): Verdict {
  const claims = extractClaims(text, locale);
  const checked: Claim[] = [];
  const unmatched: Claim[] = [];
  for (const c of claims) (factFor(c, facts) ? checked : unmatched).push(c);
  return { ok: unmatched.length === 0, checked, unmatched };
}

/** The reply the model gets once when its answer had figures the book did not give. */
export function correction(unmatched: readonly Claim[]): string {
  const list = [...new Set(unmatched.map((c) => c.raw.trim()))].join(", ");
  return `Your answer contained figures not returned by the tools: ${list}; use only tool figures or say you cannot confirm.`;
}
