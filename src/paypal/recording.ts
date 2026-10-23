import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// Record real sandbox exchanges once, replay them in contract tests.
// Recordings are sanitized at write time: no Authorization header, no OAuth
// exchange, no token/secret/password fields, no caller-listed secret values.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export interface RecordedExchange {
  seq: number;
  label?: string;
  recordedAt: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

const TOKEN_PATH = "/v1/oauth2/token";
const KEPT_REQUEST_HEADERS = ["paypal-request-id", "prefer", "content-type", "paypal-mock-response"];
const KEPT_RESPONSE_HEADERS = ["paypal-debug-id", "content-type"];
const SECRET_KEYS = /^(access_token|refresh_token|id_token|client_secret|clientsecret|password|nonce|authorization)$/i;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const REDACTED = "<redacted>";

export function sanitize(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let s = value.replace(AUTH_SCHEME, REDACTED);
    for (const secret of secrets) if (secret) s = s.split(secret).join(REDACTED);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = sanitize(v, secrets);
    }
    return out;
  }
  return value;
}

function parseBody(text: string | undefined): unknown {
  if (text === undefined || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pick(headers: Headers | Record<string, string>, keep: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : (Object.entries(headers).find(([h]) => h.toLowerCase() === k)?.[1] ?? null));
  for (const k of keep) {
    const v = get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

export function recordingFetch(
  inner: FetchLike,
  dir: string,
  opts: { secrets?: readonly string[]; label?: () => string | undefined } = {},
): FetchLike {
  mkdirSync(dir, { recursive: true });
  const secrets = opts.secrets ?? [];
  let seq = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  return async (url, init) => {
    const res = await inner(url, init);
    if (new URL(url).pathname === TOKEN_PATH) return res; // never recorded
    const text = await res.text();
    seq += 1;
    const label = opts.label?.();
    const exchange: RecordedExchange = {
      seq,
      ...(label ? { label } : {}),
      recordedAt: new Date().toISOString(),
      request: {
        method: init.method,
        url: sanitize(url, secrets) as string,
        headers: sanitize(pick(init.headers, KEPT_REQUEST_HEADERS), secrets) as Record<string, string>,
        body: sanitize(parseBody(init.body), secrets),
      },
      response: {
        status: res.status,
        headers: pick(res.headers, KEPT_RESPONSE_HEADERS),
        body: sanitize(parseBody(text), secrets),
      },
    };
    const name = `${String(seq).padStart(3, "0")}-${(label ?? init.method).replace(/[^\w.-]+/g, "_")}.json`;
    writeFileSync(path.join(dir, name), JSON.stringify(exchange, null, 2) + "\n");
    return new Response(text === "" ? null : text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export function loadExchanges(dir: string): RecordedExchange[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RecordedExchange);
}

const keyOf = (method: string, url: string) => {
  const u = new URL(url);
  return `${method.toUpperCase()} ${u.pathname}${u.search}`;
};

/**
 * Serves recorded exchanges: the first unused one with the same method + path.
 * The request body must equal the recorded one (the contract), unless strictBody is false.
 * OAuth is answered with a placeholder token because token exchanges are never recorded.
 */
export function replayFetch(source: string | RecordedExchange[], opts: { strictBody?: boolean } = {}): FetchLike {
  const pool = (typeof source === "string" ? loadExchanges(source) : source).map((e) => ({ e, used: false }));
  return async (url, init) => {
    if (new URL(url).pathname === TOKEN_PATH) {
      return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 32400, ["access" + "_token"]: "replay-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const key = keyOf(init.method, url);
    const hit = pool.find((p) => !p.used && keyOf(p.e.request.method, p.e.request.url) === key);
    if (!hit) throw new Error(`No recorded exchange for ${key}`);
    if (opts.strictBody !== false && !isDeepStrictEqual(parseBody(init.body), hit.e.request.body)) {
      throw new Error(`Request body for ${key} differs from recording #${hit.e.seq}:\n${init.body}\n!=\n${JSON.stringify(hit.e.request.body)}`);
    }
    hit.used = true;
    const { status, headers, body } = hit.e.response;
    const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers });
  };
}
