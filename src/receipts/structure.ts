// Shared by the readers: the cost of a reading's calls added up, and its output checked by the full schema.

import { z } from "zod";
import { ParsedReceipt, type ModelUsage } from "./types";
import { ModelOutputError } from "./wire";

export const sumUsage = (us: ModelUsage[]): ModelUsage => ({
  model: us[0]?.model ?? "",
  tokensIn: us.reduce((s, u) => s + u.tokensIn, 0),
  tokensOut: us.reduce((s, u) => s + u.tokensOut, 0),
  usdCeiling: us.reduce((s, u) => s + u.usdCeiling, 0),
  usdActual: us.some((u) => u.usdActual === null) ? null : us.reduce((s, u) => s + (u.usdActual ?? 0), 0),
});

/** Validates with the unchanged schema; failures carry the cost of every call made so far. */
export function validateReceipt(obj: unknown, what: string, usage: ModelUsage, raw: unknown) {
  const parsed = ParsedReceipt.safeParse(obj);
  if (!parsed.success) throw Object.assign(new ModelOutputError(`${what}: output does not match the schema: ${z.prettifyError(parsed.error)}`), { usage, raw });
  return parsed.data;
}
