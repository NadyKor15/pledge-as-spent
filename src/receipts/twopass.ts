// Reader B: prepare the photo, transcribe it verbatim (a vision call per tile), merge the tiles, then
// structure the transcription with a text-only call. Personal data and its boxes come from the vision step.

import type { CurrencyCode } from "../core/types";
import { IMAGE_FORMAT, converse, fails, kv, NOVA_MODELS, type Options } from "./bedrock";
import { groundNumbers } from "./ocr";
import { prepImage, type Box, type PrepOptions } from "./prep";
import { structureText, sumUsage, validateReceipt } from "./structure";
import { foldText, mergeRows } from "./text";
import type { ModelUsage, ReceiptImage, ReceiptReader } from "./types";

export const TRANSCRIBE_SYSTEM = `You transcribe store receipts exactly as printed, for a disaster-relief fundraiser.
Reply in plain text only. First every printed row you can fully see in this image, top to bottom, one row per line, in its original script: do not translate, do not correct, keep every digit, symbol and space as printed, and keep an amount on the same row as its product. Skip a row that is cut off at the top or bottom edge. Do not add comments.
Then, only when the image shows personal data (a card number, a person's name, a phone number, a member id), add one row for each:
PII: kind=<card_number, name, phone, address, member_id or other>; box=<x,y,w,h as fractions 0..1 of THIS image>; text=<as printed>`;


/** Splits one vision answer into transcription rows and personal-data rows (boxes in fractions of the tile). */
export function parseTranscription(answer: string): { rows: string[]; pii: { kind: string; text: string; box: Box | null }[] } {
  const rows: string[] = [];
  const pii: { kind: string; text: string; box: Box | null }[] = [];
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || /^```/.test(line.trim())) continue;
    const p = line.match(/^\s*PII\s*:\s*(.*)$/i);
    if (!p) {
      rows.push(line.trim());
      continue;
    }
    const f = kv(p[1], ["kind", "box", "text"]);
    if (!f || !f.text || f.text.trim() === "") continue;
    const n = (f.box ?? "").split(",").map((x) => Number(x.trim()));
    const box = n.length === 4 && n.every((x) => Number.isFinite(x)) ? { x: n[0], y: n[1], w: n[2], h: n[3] } : null;
    pii.push({ kind: (f.kind ?? "other").trim().toLowerCase(), text: f.text.trim(), box });
  }
  return { rows, pii };
}

export const PII_KINDS = new Set(["card_number", "name", "phone", "address", "member_id", "other"]);

export class TwoPassReader implements ReceiptReader {
  private readonly o: Required<Options>;
  constructor(opts: Options & { prep?: PrepOptions }) {
    const { prep, ...rest } = opts;
    this.o = { modelId: NOVA_MODELS.pro, maxTokens: 4096, ...rest };
    this.prep = prep ?? {};
  }
  private readonly prep: PrepOptions;

  async read(image: ReceiptImage, hint: { currency: CurrencyCode; languages: string[] }) {
    const what = `two-pass read (${this.o.modelId})`;
    const prepared = prepImage(image, this.prep);
    const tiles = prepared.tiles();
    const usages: ModelUsage[] = [];
    let rows: string[] = [];
    const pii: { kind: string; text: string; bbox: Box | null }[] = [];
    const answers: string[] = [];
    let structured: { obj: Record<string, unknown>; answer: string };
    try {
      for (const [i, tile] of tiles.entries()) {
        const { out, usage } = await converse(this.o, {
          what: `${what}: transcribe part ${i + 1} of ${tiles.length}`,
          system: TRANSCRIBE_SYSTEM,
          content: [
            { text: tiles.length > 1 ? `This is part ${i + 1} of ${tiles.length} of one receipt; the parts overlap a little.` : "This is the whole receipt." },
            { image: { format: IMAGE_FORMAT[tile.mediaType], source: { bytes: tile.bytes } } },
          ],
        });
        usages.push(usage);
        const answer = (out.output?.message?.content ?? []).map((b) => b.text ?? "").join("\n");
        answers.push(answer);
        if (out.stopReason === "max_tokens") throw fails(what, out.stopReason, usage, answer)(`transcription of part ${i + 1} was cut off`);
        const t = parseTranscription(answer);
        rows = mergeRows(rows, t.rows);
        for (const p of t.pii) {
          if (!pii.some((q) => foldText(q.text) === foldText(p.text))) pii.push({ kind: p.kind, text: p.text, bbox: p.box ? tile.toOriginal(p.box) : null });
        }
      }
      const s = await structureText(this.o, { what: `${what}: structure`, source: "transcription", text: rows.join("\n"), hint });
      usages.push(s.usage);
      structured = s;
    } catch (e) {
      // Whatever failed, the calls already made were paid for.
      if (e && typeof e === "object") {
        const err = e as { usage?: ModelUsage; raw?: unknown };
        const own = err.usage && !usages.includes(err.usage) ? [err.usage] : [];
        err.usage = sumUsage([...usages, ...own]);
        err.raw ??= { answers };
      }
      throw e;
    }
    const exp = String(structured.obj.currency) === "JPY" ? 0 : 2;
    const grounded = Array.isArray(structured.obj.lines) ? { lines: groundNumbers(structured.obj.lines as Parameters<typeof groundNumbers>[0], rows.map((text) => ({ text })), exp) } : {};
    const obj = { ...structured.obj, ...grounded, pii: pii.map((p) => ({ kind: PII_KINDS.has(p.kind) ? p.kind : "other", text: p.text, bbox: p.bbox })) };
    const usage = sumUsage(usages);
    return { receipt: validateReceipt(obj, what, usage, { transcription: rows.join("\n"), structured: structured.answer }), usage };
  }
}

