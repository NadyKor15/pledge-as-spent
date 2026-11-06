import path from "node:path";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import S from "../../eval/agent/studio-schemas-3.0.0.json";
import { POST as questionPOST } from "../app/api/agent/question/route";
import { POST as turnPOST } from "../app/api/agent/turn/route";
import { openPglite, type DatabaseHandle } from "../db/client";
import { agentQuestions, spendLedger } from "../db/schema";
import { NOVA_MODELS, type ConverseClient } from "../receipts/bedrock";
import { AgentService, repairArgs, setAgentServiceForTests, toConverse, type AgentLimits } from "./agent";
import { ServiceError } from "./errors";
import { TEXT } from "../agent/i18n";

const ROOT = path.resolve(__dirname, "../..");

type Out = Partial<ConverseCommandOutput>;
const reply = (content: unknown[], stopReason = "end_turn", usage = { inputTokens: 700, outputTokens: 60 }): Out => ({ output: { message: { role: "assistant", content: content as never } }, stopReason: stopReason as never, usage: usage as never });

function fakeClient(answers: Out[] = []) {
  const sent: ConverseCommand["input"][] = [];
  const client: ConverseClient = {
    send: async (cmd) => {
      sent.push(cmd.input);
      return (answers.shift() ?? reply([{ text: "ok" }])) as ConverseCommandOutput;
    },
  };
  return { client, sent };
}

let db: DatabaseHandle;
let t = Date.parse("2026-11-06T20:00:00.000Z");
const now = () => new Date(t).toISOString();

async function service(o: { answers?: Out[]; limits?: Partial<AgentLimits>; off?: boolean } = {}) {
  db = await openPglite();
  await db.migrate(path.join(ROOT, "drizzle"));
  const fake = fakeClient(o.answers);
  const agent = new AgentService({ db: db.db, hashIp: (ip) => `h:${ip}`, now, client: o.off ? null : () => fake.client, limits: o.limits });
  return { agent, sent: fake.sent };
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

beforeEach(() => {
  t = Date.parse("2026-11-06T20:00:00.000Z");
});
afterAll(() => setAgentServiceForTests(undefined));

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

  it("10 a day from one address, 20 a day for everyone (STEP0 §2 text)", async () => {
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
  });

  it("with the live agent off the question gets a sentence, before anything is counted", async () => {
    const { agent } = await service({ off: true });
    await expect(agent.question("1.1.1.1", {})).rejects.toMatchObject({ status: 503, code: "agent_off", message: TEXT.off.en });
    expect(await db.db.select().from(agentQuestions)).toEqual([]);
  });
});

describe("a turn", () => {
  it("is refused when malformed, for another agent, with a tool the agent may not have, or for an unknown question", async () => {
    const { agent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await expect(turnAs(agent, {})).rejects.toMatchObject({ status: 400, code: "invalid_turn" });
    await expect(turnAs(agent, turn(questionId, { agentId: "lead" }))).rejects.toMatchObject({ status: 400, code: "invalid_turn" });
    await expect(turnAs(agent, turn(questionId, { tools: [{ name: "remove_widget", description: "x", parameters: {} }] }))).rejects.toMatchObject({ status: 400, code: "tool_not_allowed" });
    await expect(turnAs(agent, turn(questionId, { agentId: "data", tools: [myTool] }))).rejects.toMatchObject({ code: "tool_not_allowed" });
    await expect(turnAs(agent, turn("00000000-0000-0000-0000-000000000000"))).rejects.toMatchObject({ status: 404, code: "unknown_question" });
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

  it("maps Studio's conversation to Converse: Lite, temperature 0, no stream, 600 tokens for the ledger agent", async () => {
    const { agent, sent } = await service({ answers: [reply([{ text: "<thinking>look up</thinking>" }, { toolUse: { toolUseId: "tu1", name: "ledger_donor_money", input: { donor: "Mark" } } }])] });
    const { questionId } = await agent.question("1.1.1.1", {});
    const r = await turnAs(agent, turn(questionId));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ modelId: NOVA_MODELS.lite, inferenceConfig: { maxTokens: 600, temperature: 0 }, toolConfig: { toolChoice: { auto: {} } } });
    expect(sent[0].system).toEqual([{ text: "Answer from the book." }]);
    // the model's thinking beside a tool call is dropped; the call comes back as Studio's function_call
    expect(r.output).toEqual([{ id: "fc_tu1", kind: "output", type: "function_call", callId: "tu1", name: "ledger_donor_money", arguments: '{"donor":"Mark"}' }]);
    expect(r).toMatchObject({ status: "completed", usage: { inputTokens: 700, outputTokens: 60 }, model: NOVA_MODELS.lite });
  });

  it("a final answer comes back as one message with <thinking> removed", async () => {
    const { agent } = await service({ answers: [reply([{ text: "<thinking>$21.45+$8.55</thinking>Your hold paid $21.45." }])] });
    const { questionId } = await agent.question("1.1.1.1", {});
    const r = await turnAs(agent, turn(questionId));
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "Your hold paid $21.45." }] });
  });

  it("the data agent gets 1 500 tokens and a compact execute_query", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, { questionId, agentId: "data", instructions: S.data.instructions, input: [userMsg("Sum of water")], tools: S.data.tools });
    expect(sent[0].inferenceConfig?.maxTokens).toBe(1500);
    const eq = sent[0].toolConfig!.tools!.find((x) => x.toolSpec?.name === "execute_query")!;
    expect(JSON.stringify(eq).length).toBeLessThan(8_000);
  });

  it("10 model calls a question, then a sentence", async () => {
    const { agent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    for (let i = 0; i < 10; i++) await turnAs(agent, turn(questionId));
    const e = await refused(turnAs(agent, turn(questionId, { locale: "de" })));
    expect(e).toMatchObject({ status: 429, code: "question_too_long", message: TEXT.tooLong.de });
  });

  it("about 40K input tokens a question, then a sentence", async () => {
    const { agent } = await service({ limits: { tokensPerQuestion: 2_000 } });
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, turn(questionId));
    await expect(turnAs(agent, turn(questionId, { input: [userMsg("x".repeat(6_000))] }))).rejects.toMatchObject({ code: "question_too_long" });
  });

  it("each call is reserved and settled as an `agent:` entry of the shared spend ledger", async () => {
    const { agent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await turnAs(agent, turn(questionId));
    const rows = await db.db.select().from(spendLedger);
    expect(rows.map((r) => r.kind)).toEqual(["reserve", "settle"]);
    expect(rows.every((r) => r.what.startsWith("agent:ledger "))).toBe(true);
    const total = rows.reduce((s, r) => s + Number(r.usd), 0);
    expect(total).toBeCloseTo((700 * 0.06 + 60 * 0.24) / 1e6, 6); // the ledger keeps six decimals
  });

  it("the agent's $0.40 sub-ceiling: refused before the call, in the donor's language", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await db.db.insert(spendLedger).values({ id: "x", ts: now(), kind: "reserve", what: "agent:ledger earlier", usd: "0.399900", ref: null });
    const e = await refused(turnAs(agent, turn(questionId, { locale: "ja" })));
    expect(e).toMatchObject({ status: 429, code: "agent_budget", message: TEXT.budget.ja });
    expect(sent).toHaveLength(0);
    // and the next question is refused at once
    await expect(agent.question("3.3.3.3", {})).rejects.toMatchObject({ code: "agent_budget" });
  });

  it("the shared $5 ceiling still holds for the agent (receipt reading spent it)", async () => {
    const { agent, sent } = await service();
    const { questionId } = await agent.question("1.1.1.1", {});
    await db.db.insert(spendLedger).values({ id: "y", ts: now(), kind: "reserve", what: "ocr read earlier", usd: "4.999990", ref: null });
    await expect(turnAs(agent, turn(questionId))).rejects.toMatchObject({ status: 429, code: "agent_budget" });
    expect(sent).toHaveLength(0);
  });
});

describe("repairArgs", () => {
  it("fills execute_query's one allowed `kind` that Nova Lite leaves out, and nothing else", () => {
    expect(repairArgs("execute_query", { query: { variant: "aggregation" } })).toEqual({ query: { variant: "aggregation", kind: "apiQuery" } });
    expect(repairArgs("execute_query", { query: { variant: "aggregation", kind: "apiQuery" } })).toEqual({ query: { variant: "aggregation", kind: "apiQuery" } });
    expect(repairArgs("ledger_line", { line: "4" })).toEqual({ line: "4" });
  });
});

describe("toConverse", () => {
  it("tool calls and results pair up as toolUse/toolResult; same-role items merge; a failed result is an error", () => {
    const req = toConverse(
      {
        questionId: "q".repeat(10),
        agentId: "ledger",
        instructions: "sys",
        input: [
          userMsg("Hi") as never,
          { type: "function_call", callId: "c1", name: "ledger_donor_money", arguments: '{"donor":"Mark"}' },
          { type: "function_call", callId: "c2", name: "ledger_refusals", arguments: "{}" },
          { type: "function_call_output", callId: "c1", output: '{"success":true,"response":"$21.45"}' },
          { type: "function_call_output", callId: "c2", output: '{"success":false,"issues":[]}' },
        ],
        tools: [myTool],
        toolChoice: "required",
      },
      NOVA_MODELS.lite,
      600,
    );
    expect(req.messages).toEqual([
      { role: "user", content: [{ text: "Hi" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "c1", name: "ledger_donor_money", input: { donor: "Mark" } } }, { toolUse: { toolUseId: "c2", name: "ledger_refusals", input: {} } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "c1", content: [{ text: '{"success":true,"response":"$21.45"}' }], status: "success" } }, { toolResult: { toolUseId: "c2", content: [{ text: '{"success":false,"issues":[]}' }], status: "error" } }] },
    ]);
    expect(req.toolConfig?.toolChoice).toEqual({ any: {} });
  });
});

describe("routes", () => {
  it("POST /api/agent/question gives an id; POST /api/agent/turn runs one turn; a limit is a 429 JSON sentence", async () => {
    const { agent } = await service({ answers: [reply([{ text: "Your hold paid $21.45." }])], limits: { questionsPerHour: 1 } });
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
