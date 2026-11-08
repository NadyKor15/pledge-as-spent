import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { ConverseCommand, type ContentBlock, type ConverseCommandOutput, type Message, type SystemContentBlock, type Tool, type ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { and, eq, gt, gte, like, lt, notLike, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agentQuestions, spendLedger } from "../db/schema";
import { novaToolSpec } from "../agent/flatten";
import { say, type TextKey } from "../agent/i18n";
import type { AgentLocale } from "../agent/money-parse";
import { fromMetaResponse, metaBody, metaUsd, toMetaRequest } from "../agent/meta-wire";
import { AGENT_TOOLS, QuestionBody, TurnBody, type AgentId, type TurnReply } from "../agent/wire";
import { NOVA_MODELS, type ConverseClient } from "../receipts/bedrock";
import { JsonlSpendLedger, SpendCap, SpendCapExceeded, worstCaseTokensIn, type LedgerEntry, type SpendLedger } from "../receipts/spend";
import { agentMetaFrom, META_AGENT_CAP_MAX_USD, META_AGENT_DAILY_CAP_DEFAULT_USD, type MetaProvider } from "./agent-env";
import { ServiceError } from "./errors";
import { META_SPEND_PREFIX } from "./spend";

// The live agent's server half. The browser runs AG Studio's agent loop (our `ledger` agent and
// Studio's built-in `data` agent); every model turn comes here, one at a time, under a question id:
// - a question is counted per address (4 an hour, 10 a day) and for everyone (20 a day);
// - a question may make 10 model calls and send about 40K input tokens, delegate turns included;
// - money: the shared $5 ceiling, and inside it $0.40 for entries whose `what` starts with "agent:";
// - only our two agents, only their tools, the model fixed here (Nova Lite unless configured).
// A refusal is a 429 with a sentence for people in EN/DE/JA, not an error.
// Honest limit: Studio builds the built-in agent's instructions in the browser, so within these
// limits this route is a proxy to Nova (STEP0 §2).

export interface AgentLimits {
  questionsPerHour: number;
  questionsPerDay: number;
  questionsPerDayAll: number;
  callsPerQuestion: number;
  tokensPerQuestion: number;
  agentCapUsd: number;
  /** The agent's spend over the last 24 hours (its `agent:` rows), inside agentCapUsd. */
  agentDailyCapUsd: number;
  spendCapUsd: number;
  /** Output allowance of a `ledger` turn (it answers the donor) and of a `data` turn (it writes queries). */
  maxTokensLedger: number;
  maxTokensData: number;
  questionTtlMinutes: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  questionsPerHour: 4,
  questionsPerDay: 10,
  questionsPerDayAll: 20,
  callsPerQuestion: 10,
  tokensPerQuestion: 40_000,
  agentCapUsd: 0.4,
  agentDailyCapUsd: 0.05,
  spendCapUsd: 5,
  maxTokensLedger: 600,
  maxTokensData: 1500,
  questionTtlMinutes: 30,
};

/** Spend entries of the live agent start with this; the sub-ceiling sums them. */
export const AGENT_PREFIX = "agent:";

/** A judging panel can share one address, so the per-address counts come from the environment (as limitsFrom in runtime.ts). */
export function agentLimitsFrom(env: NodeJS.ProcessEnv): Partial<AgentLimits> {
  const count = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const usd = (v: string | undefined) => (v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
  const out: Partial<AgentLimits> = {};
  const set = <K extends keyof AgentLimits>(k: K, v: AgentLimits[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("questionsPerHour", count(env.AGENT_QUESTIONS_PER_HOUR));
  set("questionsPerDay", count(env.AGENT_QUESTIONS_PER_DAY));
  set("questionsPerDayAll", count(env.AGENT_QUESTIONS_PER_DAY_ALL));
  set("agentCapUsd", usd(env.AGENT_CAP_USD));
  set("agentDailyCapUsd", usd(env.AGENT_DAILY_CAP_USD));
  return out;
}

/** "lite" | "pro" per agent; Lite unless set (STEP0 §2: Pro only if the measure shows Lite cannot). */
export function agentModelsFrom(env: NodeJS.ProcessEnv): Record<AgentId, string> {
  const pick = (v: string | undefined) => (v === "pro" ? NOVA_MODELS.pro : NOVA_MODELS.lite);
  return { ledger: pick(env.AGENT_MODEL_LEDGER), data: pick(env.AGENT_MODEL_DATA) };
}

/** LIVE_AGENT=on and nothing else switches the live agent on (LIVE_READING=on does not). */
export const agentLive = (env: NodeJS.ProcessEnv) => env.LIVE_AGENT === "on";

export class AgentCapExceeded extends Error {}

const SPEND_LOCK = 2; // the same lock as PgSpendLedger: one reservation at a time across both
const QUESTION_LOCK = 3;

/** The shared spend ledger with the agent's sub-ceilings (in all, and over 24 hours) checked in the same locked step. */
export class PgAgentSpendLedger implements SpendLedger {
  constructor(
    private readonly db: Db,
    private readonly capUsd: number,
    private readonly dailyCapUsd: number = Infinity,
  ) {}

  async total(): Promise<number> {
    return bedrockTotal(this.db);
  }

  async reserve(entry: LedgerEntry, maxUsd: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK}, 0)`);
      const total = (await bedrockTotal(tx)) + entry.usd;
      if (total > maxUsd) throw new SpendCapExceeded(`${entry.what}: would bring spend to $${total.toFixed(4)}, ceiling $${maxUsd.toFixed(2)}`);
      const mine = (await sumWhere(tx, AGENT_PREFIX)) + entry.usd;
      if (mine > this.capUsd) throw new AgentCapExceeded(`${entry.what}: would bring the agent's spend to $${mine.toFixed(4)}, ceiling $${this.capUsd.toFixed(2)}`);
      const today = (await sumWhere(tx, AGENT_PREFIX, dayBefore(entry.ts))) + entry.usd;
      if (today > this.dailyCapUsd) throw new AgentCapExceeded(`${entry.what}: would bring the agent's spend over 24 hours to $${today.toFixed(4)}, daily ceiling $${this.dailyCapUsd.toFixed(2)}`);
      await tx.insert(spendLedger).values(row(entry));
      return total;
    });
  }

  async settle(entry: LedgerEntry): Promise<void> {
    await this.db.insert(spendLedger).values(row(entry));
  }
}

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

/** The $5 shared with receipt reading: every row but Meta's. */
async function bedrockTotal(q: Pick<Db, "select">): Promise<number> {
  const [r] = await q
    .select({ total: sql<string>`coalesce(sum(${spendLedger.usd}), 0)::text` })
    .from(spendLedger)
    .where(notLike(spendLedger.what, `${META_SPEND_PREFIX}%`));
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

/** Development runs: the file ledger (carried into Neon at build) with a ceiling on this lane's own entries. */
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

  async reserve(entry: LedgerEntry, maxUsd: number) {
    if (this.spent() + entry.usd > this.capUsd) throw new AgentCapExceeded(`development ceiling $${this.capUsd} for "${this.prefix}" reached`);
    return this.inner.reserve(entry, maxUsd);
  }

  settle(entry: LedgerEntry) {
    return this.inner.settle(entry);
  }
}

export interface DevRun {
  ledger: DevSpendLedger;
  /** Meta's credits are kept apart from Bedrock's $5 (eval/meta-spend-ledger.jsonl, ≤ $1). */
  metaLedger?: DevSpendLedger;
  /** Each call's line goes here (docs/nadya/p3-agent/live-calls.jsonl). */
  callsLog: string;
  lane: string;
  maxCalls: number;
}

/** AGENT_DEV_LEDGER=<file> (never in production): live calls of a development run are booked to the file ledger. */
export function agentDevFrom(env: NodeJS.ProcessEnv): DevRun | undefined {
  if (env.NODE_ENV === "production" || !env.AGENT_DEV_LEDGER || !env.AGENT_DEV_CALLS_LOG) return undefined;
  const lane = env.AGENT_DEV_LANE ?? "core";
  return {
    ledger: new DevSpendLedger(env.AGENT_DEV_LEDGER, env.AGENT_DEV_PREFIX ?? "agent-dev", Number(env.AGENT_DEV_MAX_USD ?? "0.149")),
    ...(env.AGENT_DEV_META_LEDGER ? { metaLedger: new DevSpendLedger(env.AGENT_DEV_META_LEDGER, env.AGENT_DEV_PREFIX ?? "agent-dev", Math.min(1, Number(env.AGENT_DEV_META_MAX_USD ?? "1"))) } : {}),
    callsLog: env.AGENT_DEV_CALLS_LOG,
    lane,
    maxCalls: Number(env.AGENT_DEV_MAX_CALLS ?? "40"),
  };
}

export { agentMetaFrom, META_AGENT_CAP_MAX_USD, META_AGENT_DAILY_CAP_DEFAULT_USD, type MetaProvider } from "./agent-env";

/** What the reader is told answered: the chat's small print follows it. */
export const modelLabel = (model: string) => (model.startsWith("muse-") ? "Meta Muse Spark" : "Amazon Nova");

export interface AgentDeps {
  db: Db;
  hashIp(ip: string): string;
  now(): string;
  /** Null: the live agent is off on this server. */
  client: (() => ConverseClient) | null;
  /** Set: Meta is tried first for every turn (variant D), Bedrock takes over when it cannot answer. */
  meta?: MetaProvider;
  limits?: Partial<AgentLimits>;
  models?: Record<AgentId, string>;
  dev?: DevRun;
  log?: (message: string, extra?: unknown) => void;
}

const limit = (status: number, code: string, key: TextKey, locale: AgentLocale) => new ServiceError(status, code, say(key, locale), { limit: true });

/** Rough input tokens of a request: about three characters a token for JSON-heavy text (spike: 61K chars = 20.6K tokens). */
const tokensOf = (chars: number) => Math.ceil(chars / 3);

export class AgentService {
  readonly limits: AgentLimits;
  readonly models: Record<AgentId, string>;
  private client?: ConverseClient;
  /** Meta refused Studio's schemas once: send them flattened from then on. */
  metaFlat = false;

  constructor(private readonly d: AgentDeps) {
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...d.limits };
    this.models = d.models ?? { ledger: NOVA_MODELS.lite, data: NOVA_MODELS.lite };
    if (d.meta && !d.meta.apiKey) this.log(d.client ? "Meta allowed but no key: Amazon Nova answers every turn" : "Meta allowed but no key: Meta answers nothing, and the live agent is off (LIVE_AGENT is not on)");
  }

  private log(message: string, extra?: unknown) {
    (this.d.log ?? ((m, x) => console.error(`[pledge-as-spent] ${m}`, x ?? "")))(message, extra);
  }

  private ledger(): SpendLedger {
    return this.d.dev?.ledger ?? new PgAgentSpendLedger(this.d.db, this.limits.agentCapUsd, this.limits.agentDailyCapUsd);
  }

  /** Whether the agent's money is used up: in all, or over the last 24 hours (a development run: its own file ceiling). */
  private async agentSpentOut(): Promise<boolean> {
    if (this.d.dev) return this.d.dev.ledger.spent() >= this.limits.agentCapUsd - 0.005;
    if ((await sumWhere(this.d.db, AGENT_PREFIX)) >= this.limits.agentCapUsd - 0.005) return true;
    const daily = this.limits.agentDailyCapUsd;
    return (await sumWhere(this.d.db, AGENT_PREFIX, dayBefore(this.d.now()))) >= daily - Math.min(0.005, daily / 10);
  }

  /** Meta's ledger: the development file in a development run, else its `agent-meta:` rows. */
  private metaLedger(meta: MetaProvider): (SpendLedger & { capUsd: number; spent(): number | Promise<number> }) {
    return this.d.dev?.metaLedger ?? new PgMetaSpendLedger(this.d.db, meta.capUsd, meta.dailyCapUsd);
  }

  /** Whether Meta can take a new question: allowed, a key, money left in all and over the last 24 hours. */
  private async metaReady(): Promise<boolean> {
    const meta = this.d.meta;
    if (!meta?.apiKey) return false;
    const ledger = this.metaLedger(meta);
    if ((await ledger.spent()) >= ledger.capUsd - 0.005) return false;
    if (!(ledger instanceof PgMetaSpendLedger)) return true; // a development run: its file ledger's own ceiling
    const daily = ledger.dailyCapUsd;
    return (await ledger.spentSince(this.d.now())) < daily - Math.min(0.005, daily / 10);
  }

  /** A new question: counted for the address and for everyone before any model call. */
  async question(ip: string, body: unknown): Promise<{ questionId: string; model: string }> {
    const { locale = "en" } = QuestionBody.parse(body ?? {});
    const meta = await this.metaReady();
    // Meta with a key but out of money is a budget sentence; Meta without a key is the agent being off.
    const metaKeyed = Boolean(this.d.meta?.apiKey);
    if (!this.d.client && !meta) throw limit(metaKeyed ? 429 : 503, metaKeyed ? "agent_budget" : "agent_off", metaKeyed ? "budget" : "off", locale);
    if (!meta && (await this.agentSpentOut())) throw limit(429, "agent_budget", "budget", locale);
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
      await tx.insert(agentQuestions).values({ id, ipHash, ts: now, calls: 0, tokens: 0, ...(meta ? {} : { provider: "bedrock" }) });
    });
    return { questionId: id, model: meta ? "Meta Muse Spark" : "Amazon Nova" };
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
    const meta = this.d.meta ?? null;
    if (!meta && !this.d.client) throw limit(503, "agent_off", "off", locale);

    const request = toConverse(t, this.models[t.agentId], t.agentId === "ledger" ? this.limits.maxTokensLedger : this.limits.maxTokensData);
    const chars = JSON.stringify(request.system).length + JSON.stringify(request.messages).length + JSON.stringify(request.toolConfig ?? {}).length;
    const estimate = tokensOf(chars);

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
    // Variant D: Meta first. When it cannot answer, this turn and the question's later ones go to Bedrock.
    if (meta && q.provider !== "bedrock") {
      const answered = await this.metaTurn(t, meta);
      if (answered) return answered;
      await this.d.db.update(agentQuestions).set({ provider: "bedrock" }).where(eq(agentQuestions.id, t.questionId));
    }
    if (!this.d.client) throw limit(503, "agent_off", "off", locale);
    const factory = this.d.client;

    const model = request.modelId!;
    const what = dev ? `${dev.ledger.prefix} ${dev.lane} ${t.agentId} (${model})` : `${AGENT_PREFIX}${t.agentId} ${t.questionId.slice(0, 8)} (${model})`;
    const cap = new SpendCap(this.ledger(), this.limits.spendCapUsd);
    const client = (this.client ??= factory());
    const t0 = Date.now();
    const logRow: Record<string, unknown> = { ts: new Date().toISOString(), lane: dev?.lane, case: t.agentId, questionId: t.questionId, model, toolSpecChars: JSON.stringify(request.toolConfig ?? {}).length, systemChars: JSON.stringify(request.system).length, inputItems: t.input.length };
    try {
      const { value, usage } = await cap.call(
        { model, what, estimate: { textChars: JSON.stringify(request.system).length + JSON.stringify(request.messages).length, toolSpecChars: logRow.toolSpecChars as number, images: 0, maxTokens: request.inferenceConfig!.maxTokens! } },
        async () => {
          const res = await sendOnce(client, request);
          const known = res.usage?.inputTokens !== undefined && res.usage?.outputTokens !== undefined;
          return { value: res, tokensIn: known ? res.usage!.inputTokens! : null, tokensOut: known ? res.usage!.outputTokens! : null };
        },
      );
      const reply = { ...fromConverse(value, model), modelLabel: modelLabel(model) };
      Object.assign(logRow, { ok: true, ms: Date.now() - t0, stopReason: value.stopReason, usage, toolUses: reply.output.filter((o) => o.type === "function_call").map((o) => ({ name: (o as { name: string }).name, input: (o as { arguments: string }).arguments.slice(0, 400) })), text: textOf(value).slice(0, 600) });
      return reply;
    } catch (e) {
      Object.assign(logRow, { ok: false, ms: Date.now() - t0, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400) });
      if (e instanceof SpendCapExceeded || e instanceof AgentCapExceeded) throw limit(429, "agent_budget", "budget", locale);
      if (e instanceof ServiceError) throw e;
      this.log("agent turn failed",{ name: (e as Error).name, message: (e as Error).message });
      throw new ServiceError(502, "model_failed", "The live AI did not answer. Try again, or use the quick questions.");
    } finally {
      if (dev) appendFileSync(dev.callsLog, JSON.stringify(logRow) + "\n");
    }
  }

  /**
   * Variant D: one turn on Meta Muse Spark, booked to Meta's own ledger. Null when Meta cannot answer it: no key,
   * Meta's ceiling, an HTTP error, a timeout or an answer that cannot be read. The caller then asks Bedrock.
   */
  private async metaTurn(t: TurnBody, meta: MetaProvider): Promise<TurnReply | null> {
    const dev = this.d.dev;
    const ledger = this.metaLedger(meta);
    const send = meta.fetch ?? fetch;
    const t0 = Date.now();
    const logRow: Record<string, unknown> = { ts: new Date().toISOString(), lane: dev?.lane, provider: "meta", case: t.agentId, questionId: t.questionId, model: meta.model, inputItems: t.input.length };
    const log = () => {
      if (dev) appendFileSync(dev.callsLog, JSON.stringify(logRow) + "\n");
    };
    if (!meta.apiKey) {
      Object.assign(logRow, { ok: false, fallback: "no key" });
      return null; // nothing was sent: not logged as a call
    }
    const apiKey = meta.apiKey;
    const post = async (flat: boolean) => {
      const body = toMetaRequest(t, meta.model, META_MAX_OUTPUT, flat);
      const toolSpecChars = JSON.stringify(body.tools ?? []).length;
      const systemChars = String(body.instructions ?? "").length;
      Object.assign(logRow, { toolSpecChars, systemChars });
      logRow.schemas = flat ? "flat" : "as Studio wrote them";
      // Reserve the worst case before the call; correct it with the real tokens after (as SpendCap does).
      const ceiling = round6(metaUsd(meta.model, worstCaseTokensIn({ textChars: JSON.stringify(body.input).length + systemChars, toolSpecChars, images: 0, maxTokens: META_MAX_OUTPUT }), META_MAX_OUTPUT));
      const id = randomUUID();
      const what = dev ? `${dev.metaLedger?.prefix ?? "agent-dev"} ${dev.lane} meta ${t.agentId} (${meta.model})` : `${META_SPEND_PREFIX}${t.agentId} ${t.questionId.slice(0, 8)} (${meta.model})`;
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
      const reply = { ...fromMetaResponse(out.r, meta.model, repairArgs), modelLabel: modelLabel(meta.model) };
      Object.assign(logRow, { ok: true, ms: Date.now() - t0, status: out.r.status, toolUses: reply.output.filter((o) => o.type === "function_call").map((o) => ({ name: (o as { name: string }).name, input: (o as { arguments: string }).arguments.slice(0, 400) })), text: reply.output.filter((o) => o.type === "message").map((o) => JSON.stringify(o).slice(0, 600)).join(" ") });
      log();
      return reply;
    } catch (e) {
      const ceilingHit = e instanceof AgentCapExceeded || e instanceof MetaCapExceeded || e instanceof SpendCapExceeded;
      Object.assign(logRow, { ok: false, ms: Date.now() - t0, fallback: ceilingHit ? "Meta's ceiling" : "Meta failed", error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400) });
      // A refusal at the ceiling sent nothing; a failed call was attempted and is logged as one.
      if (!ceilingHit) log();
      this.log("Meta turn failed, Bedrock answers", { name: (e as Error).name, message: (e as Error).message.slice(0, 200) });
      return null;
    }
  }
}

// ---------------------------------------------------------------- variant D: Meta Muse Spark

/** Output allowance of a Muse Spark turn: its reasoning counts against it too. */
const META_MAX_OUTPUT = 2000;
const META_TIMEOUT_MS = 120_000;

export class MetaCapExceeded extends Error {}

function countLines(file: string, lane: string): number {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes(`"lane":"${lane}"`)).length;
  } catch {
    return 0;
  }
}

/** One Converse call, and one more after Nova's own broken tool call ("invalid sequence as part of ToolUse"). */
async function sendOnce(client: ConverseClient, request: ConverseCommand["input"]): Promise<ConverseCommandOutput> {
  try {
    return await client.send(new ConverseCommand(request));
  } catch (e) {
    if ((e as Error).name !== "ModelErrorException") throw e;
    return client.send(new ConverseCommand(request));
  }
}

const stripThinking = (s: string) =>
  s
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*$/i, "")
    .trim();

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

/** Studio's conversation -> Bedrock Converse. Same-role neighbours merge; the conversation starts with the user. */
export function toConverse(t: TurnBody, modelId: string, maxTokens: number): ConverseCommand["input"] {
  const system: SystemContentBlock[] = t.instructions ? [{ text: t.instructions }] : [];
  const messages: Message[] = [];
  const push = (role: "user" | "assistant", block: ContentBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content!.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of t.input) {
    if (item.type === "message") {
      const text = item.content
        .map((c) => (c as { text?: string }).text ?? (c as { refusal?: string }).refusal ?? "")
        .join("\n");
      const clean = item.role === "assistant" ? stripThinking(text) : text.trim();
      if (!clean) continue;
      if (item.role === "system") system.push({ text: clean });
      else push(item.role === "assistant" ? "assistant" : "user", { text: clean });
    } else if (item.type === "function_call") {
      push("assistant", { toolUse: { toolUseId: item.callId, name: item.name, input: parseArgs(item.arguments) as never } });
    } else if (item.type === "function_call_output") {
      let failed = false;
      try {
        failed = (JSON.parse(item.output) as { success?: boolean }).success === false;
      } catch {
        /* a plain-text result */
      }
      push("user", { toolResult: { toolUseId: item.callId, content: [{ text: item.output || "(empty)" }], status: failed ? "error" : "success" } });
    }
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ text: "Continue." }] });
  const tools: Tool[] = t.tools.map((x) => novaToolSpec(x) as Tool);
  const choice = t.toolChoice;
  const toolChoice = choice === "required" ? { any: {} } : typeof choice === "object" ? { tool: { name: choice.name } } : { auto: {} };
  const toolConfig: ToolConfiguration | undefined = tools.length ? { tools, toolChoice } : undefined;
  return { modelId, system, messages, inferenceConfig: { maxTokens, temperature: 0 }, ...(toolConfig ? { toolConfig } : {}) };
}

const textOf = (res: ConverseCommandOutput) =>
  (res.output?.message?.content ?? [])
    .map((b) => b.text ?? "")
    .join("\n");

/**
 * execute_query's `kind` has one allowed value, "apiQuery". Nova Lite left it out in 6 of 6 live
 * queries (06.11), Studio refused each and a model call was spent on the retry; it is filled in here.
 */
export function repairArgs(name: string, input: unknown): unknown {
  if (name !== "execute_query" || !input || typeof input !== "object") return input ?? {};
  const q = (input as { query?: unknown }).query;
  if (!q || typeof q !== "object" || Array.isArray(q) || "kind" in q) return input;
  return { ...input, query: { ...(q as object), kind: "apiQuery" } };
}

/** Bedrock's answer -> Studio's output items. Text beside a tool call is the model thinking aloud: dropped. */
export function fromConverse(res: ConverseCommandOutput, model: string): TurnReply {
  const blocks = res.output?.message?.content ?? [];
  const calls = blocks.filter((b) => b.toolUse).map((b) => b.toolUse!);
  const output: TurnReply["output"] = [];
  const text = stripThinking(textOf(res));
  if (calls.length === 0 && text) output.push({ id: `msg_${randomUUID()}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
  for (const c of calls) {
    output.push({ id: `fc_${c.toolUseId}`, kind: "output", type: "function_call", callId: c.toolUseId!, name: c.name!, arguments: JSON.stringify(repairArgs(c.name!, c.input)) });
  }
  const incomplete = res.stopReason === "max_tokens";
  return {
    id: `resp_${randomUUID()}`,
    output,
    status: incomplete ? "incomplete" : "completed",
    ...(incomplete ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
    usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
    model,
  };
}

// One agent service per server process, over the app's database and address hashing.
const slot = globalThis as typeof globalThis & { __pledgeAgent?: AgentService };

export async function getAgentService(): Promise<AgentService> {
  if (slot.__pledgeAgent) return slot.__pledgeAgent;
  const { getService } = await import("./runtime");
  const { bedrockClient } = await import("./aws");
  const svc = await getService();
  const env = process.env;
  slot.__pledgeAgent = new AgentService({
    db: svc.db,
    hashIp: (ip) => svc.hashIp(ip),
    now: () => svc.now(),
    client: agentLive(env) ? () => bedrockClient() : null,
    meta: agentMetaFrom(env),
    limits: agentLimitsFrom(env),
    models: agentModelsFrom(env),
    dev: agentDevFrom(env),
  });
  return slot.__pledgeAgent;
}

/** Tests put their own agent service behind the routes. */
export function setAgentServiceForTests(a: AgentService | undefined): void {
  slot.__pledgeAgent = a;
}
