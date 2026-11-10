import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import S from "../../eval/agent/studio-schemas-3.0.0.json";
import { POST as questionPOST } from "../app/api/agent/question/route";
import { POST as turnPOST } from "../app/api/agent/turn/route";
import { openPglite, type DatabaseHandle } from "../db/client";
import { agentQuestions, spendLedger } from "../db/schema";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AgentService, agentLimitsFrom, agentMetaFrom, DevSpendLedger, META_AGENT_CAP_MAX_USD, META_TRIES, repairArgs, setAgentServiceForTests, type AgentLimits } from "./agent";
import { ServiceError } from "./errors";
import { TEXT } from "../agent/i18n";

const ROOT = path.resolve(__dirname, "../..");

// The live agent runs on Meta Muse Spark only. A turn Muse Spark fails is tried once more on Muse Spark; then the
// reader gets "The assistant is busy, please try again in a minute." No other model is asked, ever.

type MetaAnswer = { status: number; body: unknown } | "timeout";
const okBody = (output: unknown[] = [{ type: "function_call", call_id: "call_1", name: "ledger_donor_money", arguments: '{"donor":"Mark"}' }]) => ({
  status: 200,
  body: { id: "resp_1", status: "completed", output, usage: { input_tokens: 1000, output_tokens: 100 } },
});
const ok = okBody();
const said = (text: string) => okBody([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
const metaCost = (1000 * 1.25 + 100 * 4.25) / 1e6;
const BASE = "https://api.meta.example/v1";

let db: DatabaseHandle;
let t = Date.parse("2026-11-06T20:00:00.000Z");
const now = () => new Date(t).toISOString();

interface Opts {
  answers?: MetaAnswer[];
  limits?: Partial<AgentLimits>;
  capUsd?: number;
  dailyCapUsd?: number;
  seed?: { usd: string; hoursAgo: number };
  apiKey?: string | null;
  dev?: boolean;
  noMeta?: boolean;
  log?: (m: string) => void;
}

/** In production shape (no development ledger) unless `dev` is asked for: Meta's spend goes to spend_ledger as `agent-meta:`. */
async function service(o: Opts = {}) {
  db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  if (o.seed) {
    t = Date.now(); // the ledger's reservations carry the real time: the service's clock follows it here
    await db.db.insert(spendLedger).values({ id: "seed", ts: new Date(t - o.seed.hoursAgo * 3_600_000).toISOString(), kind: "reserve", what: "agent-meta:ledger earlier (muse-spark-1.3)", usd: o.seed.usd, ref: null });
  }
  const answers = [...(o.answers ?? [])];
  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    const a = answers.shift() ?? ok;
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(path.join(tmpdir(), "agent-meta-"));
  const files = { meta: path.join(dir, "meta.jsonl"), calls: path.join(dir, "calls.jsonl") };
  writeFileSync(files.meta, "");
  const agent = new AgentService({
    db: db.db,
    hashIp: (ip) => `h:${ip}`,
    now,
    ...(o.noMeta ? {} : { meta: { baseUrl: BASE, apiKey: o.apiKey === undefined ? "test-key" : o.apiKey, model: "muse-spark-1.3", capUsd: o.capUsd ?? 1, ...(o.dailyCapUsd ? { dailyCapUsd: o.dailyCapUsd } : {}), fetch: fakeFetch } }),
    limits: o.limits,
    ...(o.log ? { log: o.log } : {}),
    ...(o.dev ? { dev: { metaLedger: new DevSpendLedger(files.meta, "agent-dev", o.capUsd ?? 1), callsLog: files.calls, lane: "measure-D-test", maxCalls: 30 } } : {}),
  });
  const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const rows = async (prefix: string) => (await db.db.select().from(spendLedger)).filter((r) => r.what.startsWith(prefix));
  return { agent, sent, rows, files: { meta: () => lines(files.meta), calls: () => lines(files.calls) } };
}

const userMsg = (text: string) => ({ id: "u1", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text }] });
const ledgerTools = (S.primary.tools as { name: string; description: string; parameters: object }[]).filter((x) => x.name === "delegate_to");
const myTool = { name: "ledger_donor_money", description: "d", parameters: { type: "object", properties: { donor: { type: "string" } }, required: ["donor"] } };
const turn = (questionId: string, extra: Record<string, unknown> = {}) => ({ questionId, agentId: "ledger", instructions: "Answer from the book.", input: [userMsg("What did my money buy?")], tools: [myTool, ...ledgerTools], toolChoice: "auto", ...extra });

/** A turn from the address that asked (1.1.1.1 in these tests) unless said otherwise. */
const turnAs = (agent: AgentService, body: unknown, ip = "1.1.1.1") => agent.turn(body, ip);

async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ServiceError;
  }
  throw new Error("expected a refusal");
}

// Any request that leaves the agent other than through Meta's injected fetch is a failure of these tests.
const globalFetch = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  t = Date.parse("2026-11-06T20:00:00.000Z");
  globalFetch.mockClear();
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  setAgentServiceForTests(undefined);
  globalFetch.mockRestore();
});

describe("one model: Meta Muse Spark", () => {
  it("the agent's code reaches no other model or provider: only its own modules, Node, the database layer and AG Studio, and Meta's address", () => {
    /** Imports that are not the app's own code, Node, drizzle-orm or AG Studio (another provider's SDK would be one). */
    const foreignImports = (code: string) => [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^(\.{1,2}\/|@\/|node:)/.test(s) && s !== "drizzle-orm" && s !== "ag-studio");
    /** Web addresses other than Meta's Model API. */
    const foreignUrls = (code: string) => [...code.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((u) => !u.startsWith("https://api.meta.ai/"));
    // Both checks light up on a file that reaches another provider.
    expect(foreignImports('import { Client } from "@vendor/model-sdk";\nimport { x } from "./own";')).toEqual(["@vendor/model-sdk"]);
    expect(foreignUrls('const base = "https://models.example.com/v1";')).toEqual(["https://models.example.com/v1"]);
    for (const f of ["src/server/agent.ts", "src/server/agent-env.ts", "src/agent/model-plan.ts", "src/agent/adapter.ts", "src/agent/harness.ts", "src/agent/meta-wire.ts", "src/agent/flatten.ts"]) {
      const code = readFileSync(path.join(ROOT, f), "utf8");
      expect(foreignImports(code), f).toEqual([]);
      expect(foreignUrls(code), f).toEqual([]);
    }
  });

  it("a turn goes to {base}/responses with the key; its spend is an `agent-meta:` row; the answer says Meta Muse Spark", async () => {
    const { agent, sent, rows } = await service({ answers: [ok] });
    const q = await agent.question("1.1.1.1", {});
    expect(q).toMatchObject({ model: "Meta Muse Spark" });
    const r = await turnAs(agent, turn(q.questionId));
    expect(r).toMatchObject({ model: "muse-spark-1.3", modelLabel: "Meta Muse Spark" });
    expect(r.output[0]).toMatchObject({ type: "function_call", callId: "call_1", name: "ledger_donor_money" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${BASE}/responses`, auth: "Bearer test-key", body: { model: "muse-spark-1.3", store: false, stream: false } });
    const meta = await rows("agent-meta:");
    expect(meta.map((x) => x.kind)).toEqual(["reserve", "settle"]);
    expect(meta.reduce((s, x) => s + Number(x.usd), 0)).toBeCloseTo(metaCost, 6);
    expect((await db.db.select().from(spendLedger)).every((x) => x.what.startsWith("agent-meta:"))).toBe(true);
  });

  it("a final answer comes back as one message", async () => {
    const { agent } = await service({ answers: [said("Your hold paid $21.45.")] });
    const { questionId } = await agent.question("1.1.1.1", {});
    const r = await turnAs(agent, turn(questionId));
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "Your hold paid $21.45." }] });
  });

  for (const [why, first] of [
    ["an HTTP error", { status: 500, body: { error: { message: "busy" } } }],
    ["a timeout", "timeout"],
    ["an answer that cannot be read", { status: 200, body: "not json at all" }],
  ] as const) {
    it(`${why}: the turn is tried once more on Muse Spark, and its answer is the one shown`, async () => {
      const { agent, sent } = await service({ answers: [first as MetaAnswer, said("Your hold paid $21.45.")] });
      const { questionId } = await agent.question("1.1.1.1", {});
      const r = await turnAs(agent, turn(questionId));
      expect(r).toMatchObject({ model: "muse-spark-1.3", modelLabel: "Meta Muse Spark" });
      expect(sent).toHaveLength(2);
      expect(sent.every((x) => x.url === `${BASE}/responses` && x.body.model === "muse-spark-1.3")).toBe(true);
      const [q] = await db.db.select().from(agentQuestions);
      expect(q.calls).toBe(1); // the second try is part of the same turn
    });
  }

  it("Muse Spark failing twice: 'The assistant is busy, please try again in a minute' in EN/DE/JA, after exactly two Muse Spark calls", async () => {
    expect(META_TRIES).toBe(2);
    expect(TEXT.busy.en).toBe("The assistant is busy, please try again in a minute.");
    for (const [locale, fail] of [["en", { status: 500, body: {} }], ["de", "timeout"], ["ja", { status: 503, body: {} }]] as const) {
      const said: string[] = [];
      const { agent, sent } = await service({ answers: [fail as MetaAnswer, fail as MetaAnswer, ok], log: (m) => said.push(m) });
      const { questionId } = await agent.question("1.1.1.1", {});
      const e = await refused(turnAs(agent, turn(questionId, { locale })));
      expect(e).toMatchObject({ status: 503, code: "agent_busy", message: TEXT.busy[locale], extra: { limit: true } });
      expect(sent).toHaveLength(2);
      expect(sent.every((x) => x.url === `${BASE}/responses` && x.body.model === "muse-spark-1.3")).toBe(true);
      expect(said).toEqual(["Meta turn failed (try 1 of 2)", "Meta turn failed (try 2 of 2)"]);
      // a failed call is not billed beyond what Meta reported: HTTP refusals are corrected to nothing
      if (typeof fail === "object") expect((await db.db.select().from(spendLedger)).reduce((s, x) => s + Number(x.usd), 0)).toBeCloseTo(0, 6);
    }
  });

  it("must-differ for the sentence above: one failure, then an answer, is no 'busy'", async () => {
    const { agent } = await service({ answers: [{ status: 500, body: {} }, ok] });
    const { questionId } = await agent.question("1.1.1.1", {});
    await expect(turnAs(agent, turn(questionId))).resolves.toMatchObject({ modelLabel: "Meta Muse Spark" });
  });

  it("the busy sentence reaches the reader through the route as a 503 JSON sentence", async () => {
    const { agent } = await service({ answers: [{ status: 500, body: {} }, { status: 500, body: {} }] });
    setAgentServiceForTests(agent);
    const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" } });
    const { questionId } = await (await questionPOST(post("/api/agent/question", {}))).json();
    const r = await turnPOST(post("/api/agent/turn", turn(questionId, { locale: "ja" })));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "agent_busy", message: TEXT.busy.ja, limit: true });
  });
});

describe("questions: counted per address and for everyone", () => {
  it("4 an hour from one address, then a sentence (not an error); an hour later it works again", async () => {
    const { agent } = await service();
    for (let i = 0; i < 4; i++) expect((await agent.question("1.1.1.1", {})).questionId).toMatch(/^[0-9a-f-]{36}$/);
    const e = await refused(agent.question("1.1.1.1", { locale: "de" }));
    expect(e).toMatchObject({ status: 429, code: "agent_hourly", extra: { limit: true } });
    expect(e.message).toBe(TEXT.hourly.de);
    expect((await agent.question("2.2.2.2", {})).questionId).toBeTruthy(); // another address is not affected
    t += 61 * 60_000;
    expect((await agent.question("1.1.1.1", {})).questionId).toBeTruthy();
  });

  it("10 a day from one address, 20 a day for everyone (the agreed text)", async () => {
    const { agent } = await service();
    for (let i = 0; i < 10; i++) {
      await agent.question("1.1.1.1", {});
      t += 16 * 60_000; // stay under 4 an hour
    }
    const daily = await refused(agent.question("1.1.1.1", { locale: "ja" }));
    expect(daily).toMatchObject({ status: 429, code: "agent_daily" });
    expect(daily.message).toBe(TEXT.limit.ja);
    for (let i = 0; i < 10; i++) await agent.question(`9.9.9.${i}`, {});
    const all = await refused(agent.question("8.8.8.8", {}));
    expect(all).toMatchObject({ status: 429, code: "agent_daily_all" });
    expect(all.message).toBe(TEXT.limit.en);
  });

  it("env can raise the per-address counts for a judging panel behind one address", async () => {
    const { agent } = await service({ limits: { questionsPerHour: 6 } });
    for (let i = 0; i < 6; i++) await agent.question("1.1.1.1", {});
    await expect(agent.question("1.1.1.1", {})).rejects.toMatchObject({ code: "agent_hourly" });
    expect(agentLimitsFrom({ AGENT_QUESTIONS_PER_HOUR: "6", AGENT_QUESTIONS_PER_DAY: "x" } as never)).toEqual({ questionsPerHour: 6 });
  });

  it("without Meta the agent is off: the question gets a sentence, before anything is counted", async () => {
    const { agent } = await service({ noMeta: true });
    await expect(agent.question("1.1.1.1", {})).rejects.toMatchObject({ status: 503, code: "agent_off", message: TEXT.off.en });
    await expect(turnAs(agent, turn("00000000-0000-0000-0000-000000000000"))).rejects.toMatchObject({ status: 503, code: "agent_off" });
    expect(await db.db.select().from(agentQuestions)).toEqual([]);
  });

  it("Meta allowed without a key: the agent is off (503), not out of money, and the server says so once at start", async () => {
    const said: string[] = [];
    const { agent, sent } = await service({ apiKey: null, log: (m) => said.push(m) });
    expect(said).toEqual(["Meta allowed but no key: the live agent is off"]);
    await expect(agent.question("1.1.1.1", { locale: "de" })).rejects.toMatchObject({ status: 503, code: "agent_off", message: TEXT.off.de });
    expect(sent).toHaveLength(0);
    const quiet: string[] = [];
    await service({ log: (m) => quiet.push(m) });
    expect(quiet).toEqual([]);
  });
});

describe("a turn", () => {
  it("is refused when malformed, for another agent, with a tool the agent may not have, or for an unknown question", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await expect(turnAs(agent, {})).rejects.toMatchObject({ status: 400, code: "invalid_turn" });
    await expect(turnAs(agent, turn(questionId, { agentId: "lead" }))).rejects.toMatchObject({ status: 400, code: "invalid_turn" });
    await expect(turnAs(agent, turn(questionId, { tools: [{ name: "remove_widget", description: "x", parameters: {} }] }))).rejects.toMatchObject({ status: 400, code: "tool_not_allowed" });
    await expect(turnAs(agent, turn(questionId, { agentId: "data", tools: [myTool] }))).rejects.toMatchObject({ code: "tool_not_allowed" });
    await expect(turnAs(agent, turn("00000000-0000-0000-0000-000000000000"))).rejects.toMatchObject({ status: 404, code: "unknown_question" });
    expect(sent).toHaveLength(0);
  });

  it("only the address that asked may spend the question's calls: another address gets 403, before any model call", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    const e = await refused(turnAs(agent, turn(questionId), "6.6.6.6"));
    expect(e).toMatchObject({ status: 403, code: "question_other_address" });
    expect(sent).toHaveLength(0);
    const [q] = await db.db.select().from(agentQuestions);
    expect(q.calls).toBe(0); // nothing counted against the asker
    await turnAs(agent, turn(questionId), "1.1.1.1");
    expect(sent).toHaveLength(1);
  });

  it("10 model calls a question, then a sentence", async () => {
    const { agent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    for (let i = 0; i < 10; i++) await turnAs(agent, turn(questionId));
    const e = await refused(turnAs(agent, turn(questionId, { locale: "de" })));
    expect(e).toMatchObject({ status: 429, code: "question_too_long", message: TEXT.tooLong.de });
  });

  it("30 turns of one question at once: exactly 10 reach the model, the other 20 get the sentence", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    const all = await Promise.allSettled(Array.from({ length: 30 }, () => turnAs(agent, turn(questionId))));
    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const codes = all.flatMap((r) => (r.status === "rejected" ? [(r.reason as ServiceError).code] : []));
    expect(codes).toEqual(Array(20).fill("question_too_long"));
    expect(sent).toHaveLength(10);
    const [q] = await db.db.select().from(agentQuestions);
    expect(q.calls).toBe(10);
  });

  it("the token ceiling holds at once too: parallel turns never take a question past it", async () => {
    const { agent, sent } = await service({ limits: { tokensPerQuestion: 2_000 } });
    const { questionId } = await agent.question("1.1.1.1", {});
    const all = await Promise.allSettled(Array.from({ length: 12 }, () => turnAs(agent, turn(questionId, { input: [userMsg("x".repeat(1_200))] }))));
    const ok = all.filter((r) => r.status === "fulfilled").length;
    const [q] = await db.db.select().from(agentQuestions);
    expect(q.tokens).toBeLessThanOrEqual(2_000);
    expect(ok).toBe(sent.length);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(12);
  });

  it("a refused turn says why and counts nothing: unknown 404, another address 403, too old 410", async () => {
    const { agent, sent } = await service({ limits: { questionTtlMinutes: 30 } });
    const { questionId } = await agent.question("1.1.1.1", {});
    await expect(turnAs(agent, turn("00000000-0000-0000-0000-000000000000"))).rejects.toMatchObject({ status: 404, code: "unknown_question" });
    await expect(turnAs(agent, turn(questionId), "6.6.6.6")).rejects.toMatchObject({ status: 403, code: "question_other_address" });
    t += 31 * 60_000;
    await expect(turnAs(agent, turn(questionId))).rejects.toMatchObject({ status: 410, code: "question_expired" });
    const [q] = await db.db.select().from(agentQuestions);
    expect(q.calls).toBe(0);
    expect(q.tokens).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("about 40K input tokens a question, then a sentence", async () => {
    const { agent } = await service({ limits: { tokensPerQuestion: 2_000 } });
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, turn(questionId));
    await expect(turnAs(agent, turn(questionId, { input: [userMsg("x".repeat(6_000))] }))).rejects.toMatchObject({ code: "question_too_long" });
  });
});

describe("Meta's money", () => {
  for (const [why, opts] of [
    ["Meta's ceiling", { capUsd: 0.006 }], // one turn's worst case is about $0.011
    ["Meta's daily ceiling", { dailyCapUsd: 0.006 }],
    // The provider says $50 (as if the clamp in agentMetaFrom were skipped): the ledger still stops at the $5 in code.
    ["the $5 in code", { capUsd: 50, seed: { usd: "4.990000", hoursAgo: 30 } }],
  ] as const) {
    it(`${why}: the turn gets the budget sentence, nothing is sent, and no other model answers`, async () => {
      const { agent, sent } = await service({ answers: [ok], ...(opts as Opts) });
      const q = await refused(
        (async () => {
          const { questionId } = await agent.question("1.1.1.1", {});
          return turnAs(agent, turn(questionId, { locale: "ja" }));
        })(),
      );
      expect(q).toMatchObject({ status: 429, code: "agent_budget", message: TEXT.budget.ja });
      expect(sent).toHaveLength(0);
    });
  }

  it("Meta's daily ceiling already reached: a new question gets the budget sentence at once", async () => {
    const { agent, sent } = await service({ seed: { usd: "0.499000", hoursAgo: 2 } }); // the default $0.50 over 24 hours
    await expect(agent.question("1.1.1.1", {})).rejects.toMatchObject({ status: 429, code: "agent_budget" });
    expect(sent).toHaveLength(0);
  });

  it("must-differ for the ceilings above: under them, Meta answers (a day-old $0.499, $4.98 of $5)", async () => {
    for (const seed of [{ usd: "0.499000", hoursAgo: 30 }, { usd: "4.980000", hoursAgo: 30 }]) {
      const { agent, sent } = await service({ answers: [ok], capUsd: 50, seed });
      const { questionId } = await agent.question("1.1.1.1", {});
      expect(await turnAs(agent, turn(questionId))).toMatchObject({ modelLabel: "Meta Muse Spark" });
      expect(sent).toHaveLength(1);
    }
  });

  it("Meta's ceiling is $5 in code: META_AGENT_CAP_USD can lower it, not raise it; $0.50 a day unless META_AGENT_DAILY_CAP_USD says less", () => {
    expect(META_AGENT_CAP_MAX_USD).toBe(5);
    const on = { AGENT_META_ALLOWED: "yes", META_MODEL_API_KEY: "k" };
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "50" } as never)).toMatchObject({ capUsd: 5, dailyCapUsd: 0.5 });
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "5" } as never)).toMatchObject({ capUsd: 5 });
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "0.5" } as never)).toMatchObject({ capUsd: 0.5, dailyCapUsd: 0.5 });
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "0.2" } as never)).toMatchObject({ capUsd: 0.2, dailyCapUsd: 0.2 });
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "5", META_AGENT_DAILY_CAP_USD: "0.25" } as never)).toMatchObject({ dailyCapUsd: 0.25 });
    // the daily ceiling can be lowered, never raised above $0.50
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "5", META_AGENT_DAILY_CAP_USD: "9" } as never)).toMatchObject({ dailyCapUsd: 0.5 });
    expect(agentMetaFrom({ ...on, META_AGENT_CAP_USD: "5", META_AGENT_DAILY_CAP_USD: "lots" } as never)).toMatchObject({ dailyCapUsd: 0.5 });
    // and still off without AGENT_META_ALLOWED=yes
    expect(agentMetaFrom({ META_MODEL_API_KEY: "k", META_AGENT_CAP_USD: "50" } as never)).toBeUndefined();
  });

  it("switched on only by AGENT_META_ALLOWED=yes and a ceiling above zero; off by default, in production too", () => {
    expect(agentMetaFrom({} as never)).toBeUndefined();
    expect(agentMetaFrom({ META_MODEL_API_KEY: "k", META_AGENT_CAP_USD: "1" } as never)).toBeUndefined();
    expect(agentMetaFrom({ AGENT_META_ALLOWED: "yes", META_MODEL_API_KEY: "k" } as never)).toBeUndefined();
    expect(agentMetaFrom({ AGENT_META_ALLOWED: "yes", META_MODEL_API_KEY: "k", META_AGENT_CAP_USD: "0" } as never)).toBeUndefined();
    expect(agentMetaFrom({ AGENT_META_ALLOWED: "true", META_MODEL_API_KEY: "k", META_AGENT_CAP_USD: "1" } as never)).toBeUndefined();
    expect(agentMetaFrom({ AGENT_META_ALLOWED: "yes", META_MODEL_API_KEY: "k", META_AGENT_CAP_USD: "0.5", NODE_ENV: "production" } as never)).toMatchObject({ baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", capUsd: 0.5, apiKey: "k" });
    // Allowed without a key: the agent is off (above).
    expect(agentMetaFrom({ AGENT_META_ALLOWED: "yes", META_AGENT_CAP_USD: "0.5" } as never)).toMatchObject({ apiKey: null });
  });

  it("Studio's schemas first; a refusal naming the schema sends them flattened, from then on; the refusal costs nothing", async () => {
    const refusal = { status: 400, body: { error: { message: "Invalid schema for function 'execute_query': $defs is not supported" } } };
    const { agent, sent, rows } = await service({ answers: [refusal, ok, ok] });
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, turn(questionId));
    await turnAs(agent, turn(questionId));
    expect(sent).toHaveLength(3);
    const root = (i: number) => Object.keys((sent[i].body.tools as { parameters: object }[])[1].parameters).sort(); // delegate_to
    expect(root(0)).toEqual(["additionalProperties", "properties", "required", "type"]); // as Studio wrote it
    expect(root(1)).toEqual(["properties", "required", "type"]);
    expect(root(2)).toEqual(["properties", "required", "type"]);
    expect((await rows("agent-meta:")).reduce((s, x) => s + Number(x.usd), 0)).toBeCloseTo(2 * metaCost, 6);
  });

  it("a development run books Meta to its own file ledger and logs each call with provider meta", async () => {
    const { agent, files, rows } = await service({ answers: [ok], dev: true });
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, turn(questionId));
    expect(files.meta().map((e) => e.kind)).toEqual(["reserve", "settle"]);
    expect(await rows("agent-meta:")).toEqual([]);
    expect(files.calls()[0]).toMatchObject({ provider: "meta", lane: "measure-D-test", ok: true, attempt: 1, schemas: "as Studio wrote them" });
  });
});

describe("repairArgs", () => {
  it("fills execute_query's one allowed `kind` when a model leaves it out, and nothing else", () => {
    expect(repairArgs("execute_query", { query: { variant: "aggregation" } })).toEqual({ query: { variant: "aggregation", kind: "apiQuery" } });
    expect(repairArgs("execute_query", { query: { variant: "aggregation", kind: "apiQuery" } })).toEqual({ query: { variant: "aggregation", kind: "apiQuery" } });
    expect(repairArgs("ledger_line", { line: "4" })).toEqual({ line: "4" });
  });
});

describe("routes", () => {
  it("POST /api/agent/question gives an id; POST /api/agent/turn runs one turn; a limit is a 429 JSON sentence", async () => {
    const { agent } = await service({ answers: [said("Your hold paid $21.45.")], limits: { questionsPerHour: 1 } });
    setAgentServiceForTests(agent);
    const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" } });
    const q = await questionPOST(post("/api/agent/question", {}));
    expect(q.status).toBe(201);
    const { questionId } = await q.json();
    const r = await turnPOST(post("/api/agent/turn", turn(questionId)));
    expect(r.status).toBe(200);
    expect((await r.json()).output[0].content[0].text).toBe("Your hold paid $21.45.");
    const stranger = await turnPOST(new Request("http://localhost/api/agent/turn", { method: "POST", body: JSON.stringify(turn(questionId)), headers: { "content-type": "application/json", "x-forwarded-for": "7.7.7.7" } }));
    expect(stranger.status).toBe(403);
    const again = await questionPOST(post("/api/agent/question", { locale: "de" }));
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: "agent_hourly", message: TEXT.hourly.de, limit: true });
  });
});
