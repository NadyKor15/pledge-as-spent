import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { and, eq, gt, gte, like, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agentQuestions, spendLedger } from "../db/schema";
import { say, type TextKey } from "../agent/i18n";
import type { AgentLocale } from "../agent/money-parse";
import { fromMetaResponse, metaBody, metaUsd, toMetaRequest } from "../agent/meta-wire";
import { AGENT_TOOLS, QuestionBody, TurnBody, type TurnReply } from "../agent/wire";
import { JsonlSpendLedger, worstCaseTokensIn, type LedgerEntry, type SpendLedger } from "../receipts/spend";
import { agentMetaFrom, META_AGENT_CAP_MAX_USD, META_AGENT_DAILY_CAP_DEFAULT_USD, type MetaProvider } from "./agent-env";
import { ServiceError } from "./errors";
import { META_SPEND_PREFIX } from "./spend";

// The live agent's server half. The browser runs AG Studio's agent loop (our `ledger` agent and
// Studio's built-in `data` agent); every model turn comes here, one at a time, under a question id:
// - a question is counted per address (4 an hour, 10 a day) and for everyone (20 a day);
// - a question may make 10 model calls and send about 64K input tokens, delegate turns included;
// - money: Meta's own ceilings over its `agent-meta:` rows ($5 in code at most, $0.50 over any 24 hours);
// - only our two agents, only their tools, one model: Meta Muse Spark. A turn Muse Spark fails is tried once
//   more on Muse Spark; then the reader is told the assistant is busy. No other model answers.
// A refusal is a 429 or 503 with a sentence for people in EN/DE/JA, not an error.
// Honest limit: Studio builds the built-in agent's instructions in the browser, so within these
// limits this route is a proxy to Muse Spark (a limit of the design, accepted).

export interface AgentLimits {
  questionsPerHour: number;
  questionsPerDay: number;
  questionsPerDayAll: number;
  callsPerQuestion: number;
  tokensPerQuestion: number;
  questionTtlMinutes: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  questionsPerHour: 4,
  questionsPerDay: 10,
  questionsPerDayAll: 20,
  callsPerQuestion: 10,
  // A turn of Studio's data agent weighs about 18K (the book's schema and the query tool): 64K leaves room for one turn
  // more than a sum over one need takes, when the data agent has to be asked again (live measure 11.11, Q5).
  tokensPerQuestion: 64_000,
  questionTtlMinutes: 30,
};

/** A judging panel can share one address, so the per-address counts come from the environment (as limitsFrom in runtime.ts). */
export function agentLimitsFrom(env: NodeJS.ProcessEnv): Partial<AgentLimits> {
  const count = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const out: Partial<AgentLimits> = {};
  const set = <K extends keyof AgentLimits>(k: K, v: AgentLimits[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("questionsPerHour", count(env.AGENT_QUESTIONS_PER_HOUR));
  set("questionsPerDay", count(env.AGENT_QUESTIONS_PER_DAY));
  set("questionsPerDayAll", count(env.AGENT_QUESTIONS_PER_DAY_ALL));
  return out;
}

export class AgentCapExceeded extends Error {}
export class MetaCapExceeded extends Error {}

const SPEND_LOCK = 2; // the same lock as PgMetaReadLedger (src/server/spend.ts): one reservation at a time across both
const QUESTION_LOCK = 3;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const row = (e: LedgerEntry) => ({ id: e.id, ts: e.ts, kind: e.kind, what: e.what, usd: e.usd.toFixed(6), ref: e.ref ?? null });

const dayBefore = (iso: string) => new Date(Date.parse(iso) - 86_400_000).toISOString();

/** What rows whose `what` starts with the prefix add up to; only those after `since` when given. */
async function sumWhere(q: Pick<Db, "select">, prefix: string, since?: string): Promise<number> {
  const [r] = await q
    .select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` })
    .from(spendLedger)
    .where(since ? and(like(spendLedger.what, `${prefix}%`), gt(spendLedger.ts, since)) : like(spendLedger.what, `${prefix}%`));
  return Number(r.total);
}

/**
 * Meta's own ceilings over its `agent-meta:` rows, in the same table, under the same lock: META_AGENT_CAP_USD in all
 * (never above META_AGENT_CAP_MAX_USD, whatever the caller passes) and dailyCapUsd over any 24 hours.
 */
export class PgMetaSpendLedger implements SpendLedger {
  readonly capUsd: number;
  readonly dailyCapUsd: number;

  constructor(
    private readonly db: Db,
    capUsd: number,
    dailyCapUsd: number = META_AGENT_DAILY_CAP_DEFAULT_USD,
  ) {
    this.capUsd = Math.min(capUsd, META_AGENT_CAP_MAX_USD);
    this.dailyCapUsd = Math.min(dailyCapUsd, META_AGENT_DAILY_CAP_DEFAULT_USD, this.capUsd);
  }

  spent(): Promise<number> {
    return sumWhere(this.db, META_SPEND_PREFIX);
  }

  /** Meta's spend over the 24 hours before `iso`. */
  spentSince(iso: string): Promise<number> {
    return sumWhere(this.db, META_SPEND_PREFIX, dayBefore(iso));
  }

  total(): Promise<number> {
    return this.spent();
  }

  async reserve(entry: LedgerEntry, maxUsd: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK}, 0)`);
      const total = (await sumWhere(tx, META_SPEND_PREFIX)) + entry.usd;
      if (total > Math.min(maxUsd, this.capUsd)) throw new MetaCapExceeded(`${entry.what}: would bring Meta's spend to $${total.toFixed(4)}, ceiling $${this.capUsd.toFixed(2)}`);
      const today = (await sumWhere(tx, META_SPEND_PREFIX, dayBefore(entry.ts))) + entry.usd;
      if (today > this.dailyCapUsd) throw new MetaCapExceeded(`${entry.what}: would bring Meta's spend over 24 hours to $${today.toFixed(4)}, daily ceiling $${this.dailyCapUsd.toFixed(2)}`);
      await tx.insert(spendLedger).values(row(entry));
      return total;
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.db.insert(spendLedger).values(row(entry));
  }
}

/** Development runs: a file ledger with a ceiling on this lane's own entries. */
export class DevSpendLedger implements SpendLedger {
  private readonly inner: JsonlSpendLedger;
  constructor(
    readonly file: string,
    readonly prefix: string,
    readonly capUsd: number,
  ) {
    this.inner = new JsonlSpendLedger(file);
  }

  /** What entries with the prefix add up to. */
  spent(): number {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return 0;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry)
      .filter((e) => e.what.startsWith(this.prefix))
      .reduce((s, e) => s + e.usd, 0);
  }

  total() {
    return this.inner.total();
  }

  /**
   * Two ceilings: this lane's own entries (the prefix) stay under capUsd, and the whole file — every Meta row, the
   * receipt reading's `read-meta:` ones too — under Meta's credits (META_AGENT_CAP_MAX_USD). The lane's ceiling is NOT
   * applied to the whole file: since the reading's rows share this ledger, that refused every live measure call before
   * Meta was asked (10.11: "$0.0178 would bring spend to $2.9576, ceiling $0.54", 0 calls, $0).
   */
  async reserve(entry: LedgerEntry, maxUsd: number) {
    if (this.spent() + entry.usd > Math.min(this.capUsd, maxUsd)) throw new AgentCapExceeded(`development ceiling $${this.capUsd} for "${this.prefix}" reached`);
    return this.inner.reserve(entry, META_AGENT_CAP_MAX_USD);
  }

  settle(entry: LedgerEntry) {
    return this.inner.settle(entry);
  }
}

export interface DevRun {
  /** Meta's credits in a development run (eval/meta-spend-ledger.jsonl, at most $1 in all). */
  metaLedger: DevSpendLedger;
  /** Each call's line goes here (AGENT_DEV_CALLS_LOG; scripts/agent-measure.ts sets it). */
  callsLog: string;
  lane: string;
  maxCalls: number;
}

/**
 * The lane's ceiling from AGENT_DEV_META_MAX_USD: $1 when unset, never above $1. A value that is not a finite number
 * ≥ 0 is a ceiling of 0 (every call refused): NaN would switch the ceiling off, since every comparison with NaN is false.
 */
export function devMetaCapUsd(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : 0;
}

/** AGENT_DEV_META_LEDGER=<file> (never in production): live calls of a development run are booked to the file ledger. */
export function agentDevFrom(env: NodeJS.ProcessEnv): DevRun | undefined {
  if (env.NODE_ENV === "production" || !env.AGENT_DEV_META_LEDGER || !env.AGENT_DEV_CALLS_LOG) return undefined;
  return {
    metaLedger: new DevSpendLedger(env.AGENT_DEV_META_LEDGER, env.AGENT_DEV_PREFIX ?? "agent-dev", devMetaCapUsd(env.AGENT_DEV_META_MAX_USD)),
    callsLog: env.AGENT_DEV_CALLS_LOG,
    lane: env.AGENT_DEV_LANE ?? "core",
    maxCalls: Number(env.AGENT_DEV_MAX_CALLS ?? "40"),
  };
}

export { agentMetaFrom, META_AGENT_CAP_MAX_USD, META_AGENT_DAILY_CAP_DEFAULT_USD, type MetaProvider } from "./agent-env";

/** What the reader is told answered: the chat's small print follows it. */
export const MODEL_LABEL = "Meta Muse Spark";

/** Tries of one turn on Muse Spark: the first, and one more when it fails. Then the reader is told to try later. */
export const META_TRIES = 2;

export interface AgentDeps {
  db: Db;
  hashIp(ip: string): string;
  now(): string;
  /** Meta Muse Spark, the agent's only model. Unset, or set without a key: the live agent is off on this server. */
  meta?: MetaProvider;
  limits?: Partial<AgentLimits>;
  dev?: DevRun;
  log?: (message: string, extra?: unknown) => void;
}

const limit = (status: number, code: string, key: TextKey, locale: AgentLocale) => new ServiceError(status, code, say(key, locale), { limit: true });

/** Rough input tokens of a request: about three characters a token for JSON-heavy text (spike: 61K chars = 20.6K tokens). */
const tokensOf = (chars: number) => Math.ceil(chars / 3);

/** One try of a turn on Meta: its answer, or why there is none (Meta's ceiling, or a failed call). */
type MetaTry = { reply: TurnReply } | { ceiling: true } | { failed: string };

export class AgentService {
  readonly limits: AgentLimits;
  /** Meta refused Studio's schemas once: send them flattened from then on. */
  metaFlat = false;

  constructor(private readonly d: AgentDeps) {
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...d.limits };
    if (d.meta && !d.meta.apiKey) this.log("Meta allowed but no key: the live agent is off");
  }

  private log(message: string, extra?: unknown) {
    (this.d.log ?? ((m, x) => console.error(`[pledge-as-spent] ${m}`, x ?? "")))(message, extra);
  }

  /** Meta's ledger: the development file in a development run, else its `agent-meta:` rows. */
  private metaLedger(meta: MetaProvider): SpendLedger & { capUsd: number; spent(): number | Promise<number> } {
    return this.d.dev?.metaLedger ?? new PgMetaSpendLedger(this.d.db, meta.capUsd, meta.dailyCapUsd);
  }

  /** Whether Meta can take a new question: money left in all and over the last 24 hours. */
  private async metaHasMoney(meta: MetaProvider): Promise<boolean> {
    const ledger = this.metaLedger(meta);
    if ((await ledger.spent()) >= ledger.capUsd - 0.005) return false;
    if (!(ledger instanceof PgMetaSpendLedger)) return true; // a development run: its file ledger's own ceiling
    const daily = ledger.dailyCapUsd;
    return (await ledger.spentSince(this.d.now())) < daily - Math.min(0.005, daily / 10);
  }

  /** A new question: counted for the address and for everyone before any model call. */
  async question(ip: string, body: unknown): Promise<{ questionId: string; model: string }> {
    const { locale = "en" } = QuestionBody.parse(body ?? {});
    const meta = this.d.meta;
    // Meta without a key is the agent being off; Meta out of money is a budget sentence.
    if (!meta?.apiKey) throw limit(503, "agent_off", "off", locale);
    if (!(await this.metaHasMoney(meta))) throw limit(429, "agent_budget", "budget", locale);
    const ipHash = this.d.hashIp(ip);
    const now = this.d.now();
    const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
    const dayAgo = new Date(Date.parse(now) - 86_400_000).toISOString();
    const id = randomUUID();
    await this.d.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${QUESTION_LOCK}, 0)`);
      const count = async (since: string, mine: boolean) => {
        const [r] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(agentQuestions)
          .where(mine ? and(eq(agentQuestions.ipHash, ipHash), gt(agentQuestions.ts, since)) : gt(agentQuestions.ts, since));
        return r.n;
      };
      if ((await count(hourAgo, true)) >= this.limits.questionsPerHour) throw limit(429, "agent_hourly", "hourly", locale);
      if ((await count(dayAgo, true)) >= this.limits.questionsPerDay) throw limit(429, "agent_daily", "limit", locale);
      if ((await count(dayAgo, false)) >= this.limits.questionsPerDayAll) throw limit(429, "agent_daily_all", "limit", locale);
      await tx.insert(agentQuestions).values({ id, ipHash, ts: now, calls: 0, tokens: 0 });
    });
    return { questionId: id, model: MODEL_LABEL };
  }

  /** One model turn of a question, from the address that asked it. */
  async turn(body: unknown, ip: string): Promise<TurnReply> {
    const parsed = TurnBody.safeParse(body);
    if (!parsed.success) throw new ServiceError(400, "invalid_turn", `The turn is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const t = parsed.data;
    const locale = t.locale ?? "en";
    const allowed = AGENT_TOOLS[t.agentId];
    const stray = t.tools.map((x) => x.name).filter((n) => !allowed.includes(n));
    if (stray.length) throw new ServiceError(400, "tool_not_allowed", `The ${t.agentId} agent may not use: ${stray.join(", ")}.`);
    const meta = this.d.meta;
    if (!meta?.apiKey) throw limit(503, "agent_off", "off", locale);

    const request = toMetaRequest(t, meta.model, META_MAX_OUTPUT, this.metaFlat);
    const estimate = tokensOf(String(request.instructions ?? "").length + JSON.stringify(request.input).length + JSON.stringify(request.tools ?? []).length);

    // Count the call against the question first: a call that fails still counted. The check and the count are one
    // conditional UPDATE, so turns sent at once cannot all pass the check before any of them is counted.
    const now = this.d.now();
    const since = new Date(Date.parse(now) - this.limits.questionTtlMinutes * 60_000).toISOString();
    const ipHash = this.d.hashIp(ip);
    const [q] = await this.d.db
      .update(agentQuestions)
      .set({ calls: sql`${agentQuestions.calls} + 1`, tokens: sql`${agentQuestions.tokens} + ${estimate}` })
      .where(
        and(
          eq(agentQuestions.id, t.questionId),
          // A question's calls belong to the address that asked: an id seen elsewhere spends nothing.
          eq(agentQuestions.ipHash, ipHash),
          gte(agentQuestions.ts, since),
          lt(agentQuestions.calls, this.limits.callsPerQuestion),
          sql`${agentQuestions.tokens} + ${estimate} <= ${this.limits.tokensPerQuestion}`,
        ),
      )
      .returning();
    if (!q) {
      const [row] = await this.d.db.select().from(agentQuestions).where(eq(agentQuestions.id, t.questionId));
      if (!row) throw new ServiceError(404, "unknown_question", "No such question; ask again.");
      if (row.ipHash !== ipHash) throw new ServiceError(403, "question_other_address", "This question was asked from another network; ask again.");
      if (Date.parse(row.ts) < Date.parse(since)) throw new ServiceError(410, "question_expired", "This question is too old; ask again.");
      throw limit(429, "question_too_long", "tooLong", locale);
    }

    const dev = this.d.dev;
    if (dev && countLines(dev.callsLog, dev.lane) >= dev.maxCalls) throw new ServiceError(429, "dev_calls", `Development limit of ${dev.maxCalls} live calls reached.`, { limit: true });
    // Muse Spark only: a failed turn is tried once more on Muse Spark, then the reader is asked to try again later.
    for (let attempt = 1; attempt <= META_TRIES; attempt++) {
      const out = await this.metaTurn(t, meta, attempt);
      if ("reply" in out) return out.reply;
      if ("ceiling" in out) throw limit(429, "agent_budget", "budget", locale);
    }
    throw limit(503, "agent_busy", "busy", locale);
  }

  /** One try of a turn on Meta Muse Spark, booked to Meta's own ledger. */
  private async metaTurn(t: TurnBody, meta: MetaProvider, attempt: number): Promise<MetaTry> {
    const dev = this.d.dev;
    const ledger = this.metaLedger(meta);
    const send = meta.fetch ?? fetch;
    const apiKey = meta.apiKey!;
    const t0 = Date.now();
    const logRow: Record<string, unknown> = { ts: new Date().toISOString(), lane: dev?.lane, provider: "meta", case: t.agentId, questionId: t.questionId, model: meta.model, attempt, inputItems: t.input.length };
    const log = () => {
      if (dev) appendFileSync(dev.callsLog, JSON.stringify(logRow) + "\n");
    };
    const post = async (flat: boolean) => {
      const body = toMetaRequest(t, meta.model, META_MAX_OUTPUT, flat);
      const toolSpecChars = JSON.stringify(body.tools ?? []).length;
      const systemChars = String(body.instructions ?? "").length;
      Object.assign(logRow, { toolSpecChars, systemChars });
      logRow.schemas = flat ? "flat" : "as Studio wrote them";
      // Reserve the worst case before the call; correct it with the real tokens after (as SpendCap does).
      const ceiling = round6(metaUsd(meta.model, worstCaseTokensIn({ textChars: JSON.stringify(body.input).length + systemChars, toolSpecChars, images: 0, maxTokens: META_MAX_OUTPUT }), META_MAX_OUTPUT));
      const id = randomUUID();
      const what = dev ? `${dev.metaLedger.prefix} ${dev.lane} meta ${t.agentId} (${meta.model})` : `${META_SPEND_PREFIX}${t.agentId} ${t.questionId.slice(0, 8)} (${meta.model})`;
      await ledger.reserve({ ts: new Date().toISOString(), id, kind: "reserve", what, usd: ceiling }, ledger.capUsd);
      const res = await send(`${meta.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      const text = await res.text();
      logRow.httpStatus = res.status;
      logRow.contentType = res.headers.get("content-type");
      if (!res.ok) {
        // An HTTP refusal is not billed: the reservation is corrected to nothing.
        await ledger.settle({ ts: new Date().toISOString(), id: randomUUID(), kind: "settle", ref: id, what, usd: -ceiling });
        return { ok: false as const, status: res.status, text };
      }
      const r = metaBody(text);
      const tin = r.usage?.input_tokens;
      const tout = r.usage?.output_tokens;
      const actual = tin !== undefined && tout !== undefined ? metaUsd(meta.model, tin, tout) : ceiling;
      await ledger.settle({ ts: new Date().toISOString(), id: randomUUID(), kind: "settle", ref: id, what, usd: round6(actual - ceiling) });
      logRow.usage = { model: meta.model, tokensIn: tin ?? null, tokensOut: tout ?? null, usdCeiling: ceiling, usdActual: tin !== undefined ? round6(actual) : null };
      return { ok: true as const, r };
    };
    try {
      let out = await post(this.metaFlat);
      // Studio's schemas first; a refusal that names the schema sends them flattened from then on.
      if (!out.ok && out.status === 400 && !this.metaFlat && /schema|parameters|tool|anyOf|\$ref|\$defs/i.test(out.text)) {
        logRow.firstRefusal = out.text.slice(0, 300);
        this.metaFlat = true;
        out = await post(true);
      }
      if (!out.ok) throw new Error(`Meta answered ${out.status}: ${out.text.slice(0, 300)}`);
      const reply = { ...fromMetaResponse(out.r, meta.model, repairArgs), modelLabel: MODEL_LABEL };
      Object.assign(logRow, { ok: true, ms: Date.now() - t0, status: out.r.status, toolUses: reply.output.filter((o) => o.type === "function_call").map((o) => ({ name: (o as { name: string }).name, input: (o as { arguments: string }).arguments.slice(0, 400) })), text: reply.output.filter((o) => o.type === "message").map((o) => JSON.stringify(o).slice(0, 600)).join(" ") });
      log();
      return { reply };
    } catch (e) {
      const ceilingHit = e instanceof AgentCapExceeded || e instanceof MetaCapExceeded;
      const why = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400);
      Object.assign(logRow, { ok: false, ms: Date.now() - t0, outcome: ceilingHit ? "Meta's ceiling" : "Meta failed", error: why });
      // A refusal at the ceiling sent nothing; a failed call was attempted and is logged as one.
      if (ceilingHit) return { ceiling: true };
      log();
      this.log(`Meta turn failed (try ${attempt} of ${META_TRIES})`, { name: (e as Error).name, message: (e as Error).message.slice(0, 200) });
      return { failed: why };
    }
  }
}

/** Output allowance of a Muse Spark turn: its reasoning counts against it too. */
const META_MAX_OUTPUT = 2000;
const META_TIMEOUT_MS = 120_000;

function countLines(file: string, lane: string): number {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes(`"lane":"${lane}"`)).length;
  } catch {
    return 0;
  }
}

/**
 * execute_query's `kind` has one allowed value, "apiQuery". A model left it out in 6 of 6 live
 * queries of the measure (06.11), Studio refused each and a model call was spent on the retry; it is filled in here.
 */
export function repairArgs(name: string, input: unknown): unknown {
  if (name !== "execute_query" || !input || typeof input !== "object") return input ?? {};
  const q = (input as { query?: unknown }).query;
  if (!q || typeof q !== "object" || Array.isArray(q) || "kind" in q) return input;
  return { ...input, query: { ...(q as object), kind: "apiQuery" } };
}

// One agent service per server process, over the app's database and address hashing.
const slot = globalThis as typeof globalThis & { __pledgeAgent?: AgentService };

export async function getAgentService(): Promise<AgentService> {
  if (slot.__pledgeAgent) return slot.__pledgeAgent;
  const { getService } = await import("./runtime");
  const svc = await getService();
  const env = process.env;
  slot.__pledgeAgent = new AgentService({
    db: svc.db,
    hashIp: (ip) => svc.hashIp(ip),
    now: () => svc.now(),
    meta: agentMetaFrom(env),
    limits: agentLimitsFrom(env),
    dev: agentDevFrom(env),
  });
  return slot.__pledgeAgent;
}

/** Tests put their own agent service behind the routes. */
export function setAgentServiceForTests(a: AgentService | undefined): void {
  slot.__pledgeAgent = a;
}
