// Meta's Muse Spark 1.3 (Standard) behind the receipt interfaces: one Responses call (POST {base}/responses) through
// the spend cap. Standard model only ("-contributor" models may train on what they are sent), nothing stored
// (store: false). The fetch is injected so tests never reach Meta; nothing here runs a live call by itself.

import { META_MODEL, metaBody, type MetaResponse } from "../agent/meta-wire";
import { ModelOutputError } from "./bedrock";
import type { SpendCap } from "./spend";
import type { ModelUsage, ReceiptImage } from "./types";

export const META_READ_MODEL = META_MODEL;
export const META_BASE_URL = "https://api.meta.ai/v1";
/** Worst-case tokens one image may cost (a tall sheet of cuts); the real count settles the reservation after. */
export const META_IMAGE_TOKENS = 8000;
/** The Model API takes at most 50 images in one request. */
export const META_MAX_IMAGES = 50;

export type MetaPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

export interface MetaOptions {
  apiKey: string;
  cap: SpendCap;
  /** Every ledger row's `what` starts with this (read-meta: on the server, read-meta-eval: in the measure). */
  prefix: string;
  baseUrl?: string;
  model?: string;
  /** Output allowance; Muse Spark's reasoning counts against it too. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Tries after a 429 or 5xx (each one reserved and settled on its own). */
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const dataUrl = (image: { bytes: Uint8Array; mediaType: string }) => `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;

export const imagePart = (image: ReceiptImage | { bytes: Uint8Array; mediaType: "image/jpeg" | "image/png" }): MetaPart => ({ type: "input_image", image_url: dataUrl(image) });

/** The answer's text, without the model's thinking. */
export function answerText(r: MetaResponse): string {
  return (r.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => (c.type === "output_text" ? (c.text ?? "") : ""))
    .join("")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Meta answered ${status}: ${body.slice(0, 300)}`);
  }
}

const RETRY = new Set([429, 500, 502, 503]);

type Sent = { refused: HttpRefusal; r?: undefined } | { r: MetaResponse; refused?: undefined };

/**
 * One Responses call. The worst case is reserved before it is sent; the real token counts settle it after. An HTTP
 * refusal is not billed, so its reservation is settled to nothing; a call that came back but unusable stays charged.
 */
export async function metaRespond(o: MetaOptions, args: { what: string; instructions: string; parts: MetaPart[] }): Promise<{ text: string; usage: ModelUsage; response: MetaResponse }> {
  const model = o.model ?? META_READ_MODEL;
  const maxOut = o.maxOutputTokens ?? 8000;
  const images = args.parts.filter((p) => p.type === "input_image").length;
  if (images > META_MAX_IMAGES) throw new Error(`${args.what}: ${images} images, the Model API takes at most ${META_MAX_IMAGES}`);
  const body = {
    model,
    store: false,
    stream: false,
    reasoning: { effort: "low" },
    max_output_tokens: maxOut,
    instructions: args.instructions,
    input: [{ type: "message", role: "user", content: args.parts }],
  };
  const textChars = args.instructions.length + args.parts.reduce((s, p) => s + (p.type === "input_text" ? p.text.length : 0), 0);
  const send = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = 1 + (o.retries ?? 2);
  for (let attempt = 1; ; attempt++) {
    try {
      const { value, usage } = await o.cap.call({ model, what: `${o.prefix}${args.what} (${model})`, estimate: { textChars, toolSpecChars: 0, images, maxTokens: maxOut, imageTokens: META_IMAGE_TOKENS } }, async (): Promise<{ value: Sent; tokensIn: number | null; tokensOut: number | null }> => {
        const res = await send(`${(o.baseUrl ?? META_BASE_URL).replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
        });
        const raw = await res.text();
        // Not billed: zero tokens settle the reservation to nothing, then the refusal is raised below.
        if (!res.ok) return { value: { refused: new HttpRefusal(res.status, raw) }, tokensIn: 0, tokensOut: 0 };
        const r = metaBody(raw);
        const tin = r.usage?.input_tokens;
        const tout = r.usage?.output_tokens;
        return { value: { r }, tokensIn: tin ?? null, tokensOut: tout ?? null };
      });
      if (value.refused) throw value.refused;
      const r = value.r!;
      const text = answerText(r);
      if (r.status === "failed") throw Object.assign(new ModelOutputError(`${args.what}: Meta response failed: ${r.error?.message ?? "no reason given"}`), { usage, raw: r });
      if (r.status === "incomplete") throw Object.assign(new ModelOutputError(`${args.what}: the answer was cut off (${r.incomplete_details?.reason ?? "incomplete"})`), { usage, raw: text });
      if (!text) throw Object.assign(new ModelOutputError(`${args.what}: the answer is empty`), { usage, raw: r });
      return { text, usage, response: r };
    } catch (e) {
      if (e instanceof HttpRefusal && RETRY.has(e.status) && attempt < tries) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}
