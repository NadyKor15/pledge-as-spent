"use client";

// SPIKE (CT0611-P3AGENT, 06.11): does Studio's harness run in view mode without its panel, does a
// thread survive Studio being remounted, and how big are the tool schemas a model would receive.
// No model is called: the adapter below plays a fixed script. Not product code; removed before merge.

import {
  AgStudioAiModule,
  createAiHarness,
  directLlmRunner,
  type AgAiChatSession,
  type AgAiEvent,
  type AgAiHarness,
  type AgAiHistoryStore,
  type AgAiThread,
  type AgLlmAdapter,
  type AgLlmRequest,
  type AgLlmResponse,
  type AgReportState,
  type AgStudioApi,
} from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useMemo, useState } from "react";
import closed from "../../../../tests/fixtures/drives/closed.json";
import { deriveLedger } from "@/ui/ledger/derive";
import { ledgerData } from "@/ui/ledger/studio-state";
import type { DriveView } from "@/ui/types";

type Spy = { requests: object[]; events: object[]; telemetry: object[]; notes: string[] };
const spy: Spy = { requests: [], events: [], telemetry: [], notes: [] };

// Threads outlive any one harness: Studio is remounted on layout changes, the conversation must not be.
const threads = new Map<string, AgAiThread>();
const history: AgAiHistoryStore = {
  listThreads: async () => [...threads.values()].map((t) => t.summary),
  loadThread: async (id) => threads.get(id),
  saveThread: async (t) => void threads.set(t.summary.threadId, t),
  deleteThread: async (id) => void threads.delete(id),
  addEventListener: () => {},
  removeEventListener: () => {},
};

const last = (r: AgLlmRequest) => r.input[r.input.length - 1] as { type: string; name?: string; callId?: string; role?: string };
const named = (r: AgLlmRequest, callId?: string) =>
  (r.input.find((i) => i.type === "function_call" && (i as { callId: string }).callId === callId) as { name?: string } | undefined)?.name;

let delayMs = 0;
let seq = 0;

/** Plays a script: our agent asks the ledger tool, delegates to Studio's data agent, then answers. */
const scripted: AgLlmAdapter = {
  executeTurn(request, options) {
    const n = ++seq;
    const tools = request.tools ?? [];
    spy.requests.push({
      n,
      instructionsChars: request.instructions?.length ?? 0,
      toolNames: tools.map((t) => (t as { name: string }).name),
      toolsJsonChars: JSON.stringify(tools).length,
      perTool: Object.fromEntries(tools.map((t) => [(t as { name: string }).name, JSON.stringify(t).length])),
      schemas: n <= 3 || tools.some((t) => (t as { name: string }).name === "complete_task") ? tools : undefined,
      instructions: request.instructions?.slice(0, 20000),
      inputItems: request.input.length,
      lastType: last(request).type,
    });
    const isData = tools.some((t) => (t as { name: string }).name === "execute_query");
    const prev = last(request);
    const prevName = prev.type === "function_call_output" ? named(request, prev.callId) : undefined;
    let output: AgLlmResponse["output"];
    let text = "";
    const call = (name: string, args: object) => [{ id: `fc${n}`, kind: "output" as const, type: "function_call" as const, callId: `call${n}`, name, arguments: JSON.stringify(args) }];
    if (isData) {
      if (prevName === "view_schema") output = call("complete_task", { summary: "Mark (Columbus) paid three diaper lines; the book shows his shares." });
      else output = call("view_schema", {});
    } else if (prev.type === "message") output = call("ledger_donor_money", { donor: "Mark" });
    else if (prevName === "ledger_donor_money") output = call("delegate_to", { type: { id: "data" }, instructions: "List the book lines paid by Mark (Columbus)." });
    else {
      text = "Your $30.00 hold paid $21.45 for baby diapers size M. The other $8.55 was released.";
      output = [{ id: `m${n}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }];
    }
    const events: AgAiEvent[] = [];
    for (const item of output) {
      if (item.type === "function_call") {
        events.push({ type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name } as AgAiEvent);
        events.push({ type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments } as AgAiEvent);
        events.push({ type: "TOOL_CALL_END", toolCallId: item.callId } as AgAiEvent);
      } else {
        events.push({ type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" } as AgAiEvent);
        events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text } as AgAiEvent);
        events.push({ type: "TEXT_MESSAGE_END", messageId: item.id } as AgAiEvent);
      }
    }
    const wait = () => new Promise<void>((res, rej) => {
      const t = setTimeout(res, delayMs);
      options?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
    });
    const done = wait().then(() => ({ id: `r${n}`, createdAt: Date.now(), output, status: "completed" as const }));
    return {
      stream: { async *[Symbol.asyncIterator]() { await done; for (const e of events) yield e; } },
      complete: done,
    };
  },
};

function buildHarness(api: AgStudioApi): AgAiHarness {
  const view = closed as unknown as DriveView;
  const ledgerTool = api.defineAiTool({
    name: "ledger_donor_money",
    description: "What one donor's money bought, from the book.",
    params: (s: { object: (o: object) => unknown; string: () => unknown }) => s.object({ donor: s.string() }),
    execute: async (args: { donor: string }, ctx: { success: (r: string, d?: object) => unknown; error: (m: object[]) => unknown }) => {
      const hold = view.holds.find((h) => h.donorName.toLowerCase().startsWith(args.donor.toLowerCase()));
      if (!hold) return ctx.error([{ message: `No donor ${args.donor} in the book.` }]);
      return ctx.success(`${hold.donorName}: pledged ${hold.pledged}, captured ${hold.captured}, released ${hold.released} (${hold.currency} minor units).`, { pledged: hold.pledged, captured: hold.captured, released: hold.released, currency: hold.currency });
    },
  } as never);
  return createAiHarness(api, ({ tools, builtIn }) => ({
    primary: "ledger",
    history,
    observers: [{ onEvent: (e: object) => void spy.telemetry.push(e) }],
    agents: [
      directLlmRunner({
        id: "ledger",
        name: "Ledger",
        description: "Answers what a donor's money bought, from the book only.",
        schema: (s) => s.undefined(),
        instructions: () => "Answer only from the book's tools.",
        tools: () => [ledgerTool, tools.delegateTo(["data"])],
        maxTurns: 8,
        adapter: scripted,
      }),
      directLlmRunner({ ...builtIn.data, adapter: scripted, maxTurns: 6, tools: ({ studio }) => [studio.executeQuery(), studio.viewSchema()] }),
    ],
  }));
}

const STATE: AgReportState = {
  selectedPageId: "p",
  pages: [{
    id: "p",
    widgets: { book: { type: "grid", dataMapping: { cols: ["line", "item", "payer", "share", "capture", "status", "order"].map((c) => ({ id: `book.${c}` })) }, format: { title: { enabled: false } } } } as never,
    widgetLayout: { book: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 30 } },
  }],
};

declare global { interface Window { __spike?: object } }

export function Spike() {
  const model = useMemo(() => deriveLedger(closed as unknown as DriveView), []);
  const data = useMemo(() => ledgerData(model), [model]);
  const [mount, setMount] = useState(0);
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [, tick] = useState(0);
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const on = () => tick((x) => x + 1);
    session.addEventListener("changed", on);
    return () => session.removeEventListener("changed", on);
  }, [session]);

  useEffect(() => {
    window.__spike = {
      spy,
      remount: () => setMount((m) => m + 1),
      setDelay: (ms: number) => { delayMs = ms; },
      send: (text: string) => session?.sendMessage(text),
      snapshot: () => ({ mount, threadId, status: session?.status, messages: session?.messages, threads: [...threads.keys()] }),
    };
  });

  async function ready(api: AgStudioApi) {
    try {
      const harness = buildHarness(api);
      spy.notes.push(`mount ${mount}: harness built, agents=${harness.agents.map((a) => a.id).join(",")}`);
      if (threadId) {
        // The roster loads from history asynchronously; opening before it lands fails with "Unknown thread".
        const t0 = performance.now();
        while (!harness.threads.some((t) => t.threadId === threadId) && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
        spy.notes.push(`mount ${mount}: roster has thread after ${Math.round(performance.now() - t0)} ms: ${harness.threads.some((t) => t.threadId === threadId)}`);
      }
      const s = threadId ? await harness.openThread(threadId) : await harness.createThread({ agentId: "ledger" });
      spy.notes.push(`mount ${mount}: session ${s.threadId}, messages=${s.messages.length}, status=${s.status}`);
      setThreadId(s.threadId);
      setSession(s);
      const studioTools = api.getAiTools();
      spy.notes.push(`studio tool schema chars: execute_query=${JSON.stringify(studioTools.executeQuery().schema()).length}, view_schema=${JSON.stringify(studioTools.viewSchema().schema()).length}`);
    } catch (e) {
      spy.notes.push(`mount ${mount}: ERROR ${(e as Error).stack ?? String(e)}`);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", padding: 12 }}>
      <p data-testid="status">mount {mount} · thread {threadId ?? "-"} · status {session?.status ?? "-"}</p>
      <ol data-testid="messages">
        {session?.messages.map((m, i) => <li key={i}>{JSON.stringify(m).slice(0, 400)}</li>)}
      </ol>
      <AgStudioProvider modules={[AgStudioAiModule]}>
        <div style={{ height: 600 }}>
          <AgStudio key={mount} style={{ width: "100%", height: "100%" }} data={data} initialState={STATE} mode="view" panels={{ view: { left: [], right: [] }, edit: { left: [], right: [] } }} onStudioReady={(e) => void ready(e.api)} />
        </div>
      </AgStudioProvider>
    </main>
  );
}
