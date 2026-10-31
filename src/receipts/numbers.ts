// Nova's copy of the numbers on a receipt: Nova invents Japanese words but copies digits faithfully, so it is told
// to leave words out. Only the part of the photo down to the total goes to the model: the card and loyalty rows
// below it are not needed here, and the content filter refuses them now and then.

import { IMAGE_FORMAT, converse, type Options } from "./bedrock";
import { mergeRows } from "./text";
import type { Tile } from "./prep";
import type { ModelUsage } from "./types";

export const NUMBERS_SYSTEM = `You copy the numbers from a photo of a store receipt. Reply in plain text only: one line for each printed row, top to bottom, keeping every digit and the symbols ¥ $ € , . : / - * % x and Latin letters exactly as printed. Do not read Japanese words: write one • in place of each Japanese word. Never fix, add or calculate anything. Example of an answer:
•
TEL 0120-11-2233
2025年03月07日(•) 09:05
• 2L ¥798
4• x •118
• 20• ¥698`;

export interface PhotoNumbers {
  rows: string[];
  usage: ModelUsage[];
  /** Parts of the photo the model did not answer for (its content filter, a cut-off answer). */
  failed: number;
}

export async function readNumbers(o: Required<Options>, tiles: Tile[], what: string): Promise<PhotoNumbers> {
  let rows: string[] = [];
  const usage: ModelUsage[] = [];
  let failed = 0;
  for (const [i, tile] of tiles.entries()) {
    const r = await converse(o, {
      what: `${what}: numbers ${i + 1} of ${tiles.length}`,
      system: NUMBERS_SYSTEM,
      content: [
        { text: tiles.length > 1 ? `Part ${i + 1} of ${tiles.length} of one receipt; the parts overlap a little.` : "The whole receipt." },
        { image: { format: IMAGE_FORMAT[tile.mediaType], source: { bytes: tile.bytes } } },
      ],
    });
    usage.push(r.usage);
    if (r.out.stopReason !== "end_turn") {
      failed++;
      continue;
    }
    const text = (r.out.output?.message?.content ?? []).map((b) => b.text ?? "").join("\n");
    rows = mergeRows(rows, text.split(/\r?\n/).map((t) => t.trim()).filter((t) => t !== ""));
  }
  return { rows, usage, failed };
}
