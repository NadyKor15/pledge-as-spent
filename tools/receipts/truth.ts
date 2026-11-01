import { z } from "zod";
import { LineClassification, ParsedReceipt } from "../../src/receipts/types";
import { ReceiptSpec } from "./spec";

/** Ground truth stored beside each image (`<id>.truth.json`). */
export const Truth = z.object({
  id: z.string(),
  set: z.enum(["v1", "adversarial", "hero", "holdout"]),
  locale: z.enum(["ja", "tr", "es", "en"]),
  seed: z.number().int(),
  driveId: z.string(),
  image: z.object({ file: z.string(), sha256: z.string().length(64), mediaType: z.enum(["image/png", "image/jpeg"]), width: z.number().int(), height: z.number().int() }),
  /** What a perfect reader returns; PII boxes are where the text sits on the image. */
  receipt: ParsedReceipt,
  /** What a perfect classifier returns for the set's drive and needs. */
  labels: z.array(LineClassification),
  expect: ReceiptSpec.shape.expect,
  spec: ReceiptSpec,
});
export type Truth = z.infer<typeof Truth>;
