import { readFileSync } from "node:fs";
import path from "node:path";
import { loadExchanges, replayFetch, type FetchLike } from "../../../src/paypal/recording";
import { ROOT } from "./harness";

// Replays the live e2e recording (tests/fixtures/paypal/app-e2e) strictly:
// every request body must equal the recorded one. On top of replayFetch:
// - a POST repeating a PayPal-Request-Id returns the first answer with HTTP 200
//   and consumes nothing, which is what the sandbox did (fixture story/020);
// - a GET asked more often than recorded gets the last recorded answer (a read).

export const APP_E2E = path.join(ROOT, "tests/fixtures/paypal/app-e2e");
export const appE2eMeta = () =>
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/paypal/app-e2e.meta.json"), "utf8")) as { runId: string; startedAt: string; driveId: string; volunteer: string };

export interface ReplayLog {
  method: string;
  path: string;
  requestId?: string;
  /** true: answered from the request-id cache, nothing consumed. */
  repeat: boolean;
}

export function sandboxReplay(dir = APP_E2E) {
  const exchanges = loadExchanges(dir);
  const strict = replayFetch(exchanges);
  const answered = new Map<string, { status: number; text: string; headers: [string, string][] }>();
  const lastGet = new Map<string, { status: number; text: string; headers: [string, string][] }>();
  const log: ReplayLog[] = [];
  const keep = async (res: Response) => ({ status: res.status, text: await res.clone().text(), headers: [...res.headers.entries()] });
  const make = (k: { status: number; text: string; headers: [string, string][] }, status = k.status) => new Response(k.text === "" ? null : k.text, { status, headers: k.headers });

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/oauth2/token") return strict(url, init);
    const requestId = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1];
    const key = `${init.method} ${u.pathname} ${requestId ?? ""}`;
    if (init.method === "POST" && requestId && answered.has(key)) {
      log.push({ method: init.method, path: u.pathname, requestId, repeat: true });
      const k = answered.get(key)!;
      return make(k, k.status === 201 ? 200 : k.status);
    }
    let res: Response;
    try {
      res = await strict(url, init);
    } catch (e) {
      const last = lastGet.get(u.pathname);
      if (init.method !== "GET" || !last) throw e;
      res = make(last);
    }
    log.push({ method: init.method, path: u.pathname, requestId, repeat: false });
    const k = await keep(res);
    if (init.method === "POST" && requestId && res.status < 500) answered.set(key, k);
    if (init.method === "GET") lastGet.set(u.pathname, k);
    return res;
  };
  return { fetch, log, exchanges };
}
