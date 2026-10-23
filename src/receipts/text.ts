// Small text helpers shared by the multi-step readers.

export const foldText = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 1 for equal after folding, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const x = foldText(a);
  const y = foldText(b);
  if (!x.length && !y.length) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Appends the rows of the next tile to the rows so far, dropping the rows the two tiles share because they
 * overlap. The overlap is the longest run (up to `maxOverlap` rows) at the end of `rows` that matches, row by
 * row and fuzzily, the start of `next`; a legitimately repeated line elsewhere is kept.
 */
export function mergeRows(rows: string[], next: string[], maxOverlap = 14, minSimilarity = 0.8): string[] {
  for (let k = Math.min(maxOverlap, rows.length, next.length); k >= 1; k--) {
    const tail = rows.slice(rows.length - k);
    // A single short row (a rule line, "TOTAL") is not evidence of an overlap by itself.
    if (k === 1 && foldText(next[0]).length < 6) continue;
    if (tail.every((r, i) => similarity(r, next[i]) >= minSimilarity)) return [...rows, ...next.slice(k)];
  }
  return [...rows, ...next];
}
