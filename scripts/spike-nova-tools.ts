// SPIKE (CT0611-P3AGENT, 06.11): do Amazon Nova Lite and Pro accept Studio's real tool schemas
// (delegate_to; the data agent's execute_query with $defs/$ref/anyOf), and do they answer with a
// usable call? Four live Converse calls at most, each reserved and settled in eval/spend-ledger.jsonl
// (carried into Neon at build). Not product code; removed before merge.
// Run: ../tools/p3/withp3.sh npx tsx scripts/spike-nova-tools.ts <schemas.json> <out.jsonl>

import { ConverseCommand, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { appendFileSync, readFileSync } from "node:fs";
import { createBedrockClient, NOVA_MODELS } from "../src/receipts/bedrock";
import { JsonlSpendLedger, SpendCap } from "../src/receipts/spend";

type Json = Record<string, unknown>;
const [schemasFile, outFile] = process.argv.slice(2);
const S = JSON.parse(readFileSync(schemasFile, "utf8")) as { primary: { tools: Json[] }; data: { instructions: string; tools: Json[] } };
const DEV_CAP_USD = 0.15;
const LEDGER = "eval/spend-ledger.jsonl";

/** Inline every $ref from the root's $defs and drop what Nova does not accept at the top level. */
export function forNova(params: Json): Json {
  const defs = (params.$defs ?? {}) as Record<string, unknown>;
  // Recursive definitions (expressions, filter groups) are opened once per path; a second visit
  // becomes a plain object, so the schema stays finite and keeps one level of nesting.
  const walk = (v: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, path));
    if (!v || typeof v !== "object") return v;
    const o = v as Json;
    if (typeof o.$ref === "string") {
      const name = (o.$ref as string).replace("#/$defs/", "");
      if (path.includes(name)) return { type: "object", description: `A nested ${name}, same shape as the one around it.` };
      return walk(defs[name], [...path, name]);
    }
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "$defs").map(([k, x]) => [k, walk(x, path)]));
  };
  const flat = walk(params, []) as Json;
  return { type: "object", properties: flat.properties ?? {}, required: flat.required ?? [] };
}

const toolSpec = (t: Json): Tool => ({ toolSpec: { name: t.name as string, description: t.description as string, inputSchema: { json: forNova(t.parameters as Json) as never } } });

function devSpent(): number {
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { what: string; usd: number })
    .filter((e) => e.what.startsWith("agent-dev")).reduce((s, e) => s + e.usd, 0);
}

const client = createBedrockClient();
const cap = new SpendCap(new JsonlSpendLedger(LEDGER));

const primarySystem = "You are Ledger, a read-only assistant for the book of one relief drive. Use your tools; state only figures your tools returned. When the question needs individual book lines, delegate to the data agent with delegate_to.";
const primaryMessages: Message[] = [
  { role: "user", content: [{ text: "I'm Mark from Columbus. Which lines of the book did my money pay for?" }] },
  { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "ledger_donor_money", input: { donor: "Mark" } } }] },
  { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "Mark (Columbus): pledged 3000, captured 2145, released 855 (USD minor units)." }] } }] },
];
const dataMessages: Message[] = [{ role: "user", content: [{ text: "List the book lines paid by Mark (Columbus)." }] }];

const cases = [
  { name: "primary", model: NOVA_MODELS.lite, system: primarySystem, messages: primaryMessages, tools: S.primary.tools },
  { name: "data", model: NOVA_MODELS.lite, system: S.data.instructions, messages: dataMessages, tools: S.data.tools },
  { name: "primary", model: NOVA_MODELS.pro, system: primarySystem, messages: primaryMessages, tools: S.primary.tools },
  { name: "data", model: NOVA_MODELS.pro, system: S.data.instructions, messages: dataMessages, tools: S.data.tools },
];

async function main() {
for (const c of cases) {
  if (devSpent() > DEV_CAP_USD) { console.log(`STOP dev cap $${DEV_CAP_USD} reached`); break; }
  const tools = c.tools.map(toolSpec);
  const what = `agent-dev spike ${c.name} (${c.model})`;
  const t0 = Date.now();
  const row: Json = { ts: new Date().toISOString(), case: c.name, model: c.model, toolSpecChars: JSON.stringify(tools).length, systemChars: c.system.length };
  try {
    const { value, usage } = await cap.call(
      { model: c.model, what, estimate: { textChars: c.system.length + 400, toolSpecChars: JSON.stringify(tools).length, images: 0, maxTokens: 800 } },
      async () => {
        const res = await client.send(new ConverseCommand({ modelId: c.model, system: [{ text: c.system }], messages: c.messages, inferenceConfig: { maxTokens: 800, temperature: 0 }, toolConfig: { tools, toolChoice: { auto: {} } } }));
        return { value: res, tokensIn: res.usage?.inputTokens ?? null, tokensOut: res.usage?.outputTokens ?? null };
      },
    );
    const content = value.output?.message?.content ?? [];
    Object.assign(row, {
      ok: true, ms: Date.now() - t0, stopReason: value.stopReason, usage,
      toolUses: content.filter((b) => b.toolUse).map((b) => ({ name: b.toolUse!.name, input: b.toolUse!.input })),
      text: content.filter((b) => b.text).map((b) => b.text).join("\n").slice(0, 600),
    });
  } catch (e) {
    Object.assign(row, { ok: false, ms: Date.now() - t0, error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 600) });
  }
  appendFileSync(outFile, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row).slice(0, 700));
}
console.log(`dev spent so far: $${devSpent().toFixed(6)}`);
}

void main();
