import { readFileSync } from "node:fs";
import path from "node:path";
import { openPglite, type DatabaseHandle } from "../../../src/db/client";
import type { FetchLike } from "../../../src/paypal/recording";
import type { ConverseClient } from "../../../src/receipts/bedrock";
import { Recordings } from "../../../src/receipts/recorded";
import type { Pipeline } from "../../../src/server/reading";
import { PledgeService, type Limits } from "../../../src/server/service";
import { FAKE_EPOCH } from "./fake-sandbox";

export const ROOT = path.resolve(__dirname, "../../..");
export const HERO_PNG = path.join(ROOT, "eval/receipts/hero/hero-ja-01.png");
export const heroBytes = () => new Uint8Array(readFileSync(HERO_PNG));
export const receiptBytes = (rel: string) => new Uint8Array(readFileSync(path.join(ROOT, rel)));

export function loadRecordings(): Recordings {
  return Recordings.parse(JSON.parse(readFileSync(path.join(ROOT, "eval/receipts/recorded.json"), "utf8")));
}

export interface Clock {
  now: () => string;
  advance(ms: number): void;
  set(iso: string): void;
}

export function clock(start: string): Clock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms;
    },
    set: (iso) => {
      t = Date.parse(iso);
    },
  };
}

export interface Harness {
  svc: PledgeService;
  db: DatabaseHandle;
  clock: Clock;
  /** A second service over the same database: the process after a restart. */
  restart(fetch?: FetchLike): PledgeService;
}

export async function harness(o: {
  fetch: FetchLike;
  start?: string;
  recordings?: Recordings;
  bedrock?: () => ConverseClient;
  pipeline?: Pipeline;
  limits?: Partial<Limits>;
  webhookId?: string | null;
  demoPayoutEmail?: string | null;
}): Promise<Harness> {
  const db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  const c = clock(o.start ?? FAKE_EPOCH);
  const make = (fetch: FetchLike) =>
    new PledgeService({
      db: db.db,
      recordings: o.recordings ?? loadRecordings(),
      paypal: { clientId: "test-client", clientSecret: "test-secret", fetch, retryDelayMs: 0 },
      webhookId: o.webhookId === undefined ? "WH-TEST" : o.webhookId,
      demoPayoutEmail: o.demoPayoutEmail === undefined ? "sb-pywsi53523660@personal.example.com" : o.demoPayoutEmail,
      ipHashKey: "test-key",
      bedrock: o.bedrock,
      pipeline: o.pipeline,
      now: c.now,
      limits: o.limits,
      log: () => {},
    });
  return { svc: make(o.fetch), db, clock: c, restart: (fetch = o.fetch) => make(fetch) };
}
