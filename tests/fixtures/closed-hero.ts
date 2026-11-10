import { readFileSync } from "node:fs";
import path from "node:path";
import shippedLines from "../../eval/baseline-legacy/live/shipped/hero-ja-01.lines.json";
import { closeReceipt, type Band, type PurchaseLine } from "../../src/receipts/close";
import type { PledgeService } from "../../src/server/service";

// The sample receipt closed to its purchase lines, for tests that need the published copy without a reader: each
// line's printed box (eval/baseline-legacy/live/shipped/hero-ja-01.lines.json, measured on the photo) taken as its band, reaching a
// fifth of its height into the gaps above and below. These boxes cover a line's main row only, so its quantity row
// shows cut; the reader's own bands are whole rows and a line names all of its rows.

const ROOT = path.resolve(__dirname, "../..");
export const HERO_PHOTO = path.join(ROOT, "eval/receipts/hero/hero-ja-01.png");
export const HERO_SIZE = { width: 630, height: 1292 } as const;
export const HERO_SHA256 = shippedLines.imageSha256;

export function heroClosing(): { bands: Band[]; purchaseLines: PurchaseLine[] } {
  const { width: W, height: H } = HERO_SIZE;
  const bands = shippedLines.lineBoxes.map(({ box }, i): Band => {
    const pad = 0.2 * box.h * H;
    const x0 = box.x * W - 4;
    const x1 = (box.x + box.w) * W + 4;
    const y0 = box.y * H - pad;
    const y1 = (box.y + box.h) * H + pad;
    return { index: i + 1, y0, y1, quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  });
  return { bands, purchaseLines: shippedLines.lineBoxes.map((l, i) => ({ lineNo: l.lineNo, bandIndexes: [i + 1] })) };
}

/** The published copy of the sample receipt, as the reading makes it once it has placed the lines. */
export function heroClosed(): Buffer {
  const { bands, purchaseLines } = heroClosing();
  const closed = closeReceipt({ bytes: new Uint8Array(readFileSync(HERO_PHOTO)), mediaType: "image/png" }, bands, purchaseLines);
  if (!closed) throw new Error("the sample receipt did not close");
  return Buffer.from(closed);
}

/**
 * The reading as the Meta reader returns it for the sample receipt: its bands, its purchase lines and the photo closed
 * by them (`closed`). The truth recordings carry no rows, so tests add them to the sample's reading the same way.
 */
export function placeLines(svc: PledgeService): void {
  type Input = { image: { bytes: Uint8Array; mediaType: "image/png" | "image/jpeg" | "image/webp" }; sha256: string };
  const reading = (svc as unknown as { reading: { read: (input: Input) => Promise<object> } }).reading;
  const read = reading.read.bind(reading);
  reading.read = async (input) => {
    const r = await read(input);
    if (input.sha256 !== HERO_SHA256) return r;
    const { bands, purchaseLines } = heroClosing();
    return { ...r, bands, purchaseLines, closed: closeReceipt(input.image, bands, purchaseLines) };
  };
}
