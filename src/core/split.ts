import { CoreError } from "./errors";

export interface Weighted {
  id: string;
  weight: number;
}

export interface Portion {
  id: string;
  amount: number;
}

/**
 * Splits an integer total in proportion to integer weights by the largest
 * remainder method. Leftover units go to the largest remainders; ties go to the
 * smaller id, so the result does not depend on input order. When
 * total <= sum(weights), no portion exceeds its weight.
 * Returns one portion per input part, in input order.
 */
export function largestRemainder(total: number, parts: readonly Weighted[]): Portion[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new CoreError("invalid_split", `total must be a non-negative integer, got ${total}`);
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const p of parts) {
    if (!Number.isSafeInteger(p.weight) || p.weight < 0) {
      throw new CoreError("invalid_split", `weight of ${p.id} must be a non-negative integer, got ${p.weight}`);
    }
    if (seen.has(p.id)) throw new CoreError("invalid_split", `duplicate id ${p.id}`);
    seen.add(p.id);
    sum += BigInt(p.weight);
  }
  if (total === 0) return parts.map((p) => ({ id: p.id, amount: 0 }));
  if (sum === 0n) throw new CoreError("invalid_split", `cannot split ${total} over zero total weight`);

  const T = BigInt(total);
  const rows = parts.map((p, index) => {
    const product = T * BigInt(p.weight);
    return { id: p.id, index, floor: product / sum, rem: product % sum };
  });
  let leftover = T - rows.reduce((acc, r) => acc + r.floor, 0n);
  const order = rows
    .filter((r) => r.rem > 0n)
    .sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  const bonus = new Set<number>();
  for (const r of order) {
    if (leftover === 0n) break;
    bonus.add(r.index);
    leftover -= 1n;
  }
  if (leftover !== 0n) throw new CoreError("invariant_violation", "largest remainder left units undistributed");
  return rows.map((r) => ({ id: r.id, amount: Number(r.floor) + (bonus.has(r.index) ? 1 : 0) }));
}
