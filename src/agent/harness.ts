import { createAiHarness, directLlmRunner, type AgAiChatSession, type AgAiHarness, type AgAiHistoryStore, type AgAiThread, type AgLlmAdapter, type AgStudioApi } from "ag-studio";
import type { DriveView } from "@/ui/types";
import { guardedAdapter, novaAdapter, type GuardOutcome } from "./adapter";
import { FactRegistry } from "./facts";
import { linesFor, type Verdict } from "./guard";
import { say } from "./i18n";
import type { AgentLocale } from "./money-parse";
import { LEDGER_DESCRIPTION, ledgerInstructions } from "./prompts";
import { answerStarter, STARTERS, starterPrompt, type StarterId } from "./starters";
import { ledgerAiTools } from "./tools";
import type { Fact } from "./types";
import type { AgentId } from "./wire";

// Our `ledger` agent inside AG Studio: primary agent of Studio's own harness, with the book's
// read-only tools and delegation to Studio's built-in `data` agent (execute_query and view_schema
// only — it cannot change the report). The book renders Studio in view mode, which has no chat
// panel, so the chat is our widget on the harness's session (spike 06.11: works).
//
// Studio is rebuilt by `key` when the layout, the phase or the language change. The conversation
// must not go with it: the history store lives outside Studio, and each new Studio gets a new
// harness that reopens the thread. A turn that was running when Studio went is lost; the reader is
// told "the book changed while I was answering — ask again" and gets a button for it.

/** Threads kept outside any one Studio. */
export class MemoryHistory implements AgAiHistoryStore {
  private readonly threads = new Map<string, AgAiThread>();
  listThreads = async () => [...this.threads.values()].map((t) => t.summary);
  loadThread = async (id: string) => this.threads.get(id);
  saveThread = async (t: AgAiThread) => void this.threads.set(t.summary.threadId, t);
  deleteThread = async (id: string) => void this.threads.delete(id);
  addEventListener() {}
  removeEventListener() {}
}

export interface AttachOptions {
  getView: () => DriveView;
  history: AgAiHistoryStore;
  facts: FactRegistry;
  locale: () => AgentLocale;
  adapterFor: (agentId: AgentId) => AgLlmAdapter;
}

/** Studio's harness for one Studio instance: our agent (primary) and the data agent it may ask. */
export function attachLedgerAgent(api: AgStudioApi, o: AttachOptions): AgAiHarness {
  const bookTools = ledgerAiTools(o.getView);
  return createAiHarness(api, ({ tools, builtIn }) => ({
    primary: "ledger",
    history: o.history,
    observers: [o.facts.observer],
    promptStarters: STARTERS.map((s) => ({ label: s.label[o.locale()], prompt: starterPrompt(s.id, o.locale()) })),
    agents: [
      directLlmRunner({
        id: "ledger",
        name: "Ledger",
        description: LEDGER_DESCRIPTION,
        schema: (s) => s.undefined(),
        instructions: () => ledgerInstructions(o.locale()),
        tools: () => [...bookTools, tools.delegateTo(["data"])],
        maxTurns: 8,
        adapter: o.adapterFor("ledger"),
      }),
      // Read-only: no create/update/delete_expression, so the data agent cannot change the report.
      directLlmRunner({ ...builtIn.data, adapter: o.adapterFor("data"), maxTurns: 6, tools: ({ studio }) => [studio.executeQuery(), studio.viewSchema()] }),
    ],
  }));
}

export type AskPhase = "idle" | "asking" | "thinking" | "answered" | "cannot" | "limit" | "interrupted" | "error" | "who";

export interface AskAnswer {
  question: string;
  text: string;
  verdict: Verdict;
  facts: readonly Fact[];
  /** "ai": the live agent; "code": a quick question answered by the book's code. */
  source: "ai" | "code";
  /** What our agent asked Studio's data agent, when it did. */
  delegated: readonly string[];
  retried: boolean;
  replaced: boolean;
  lineKeys: readonly string[];
  /** The model's own words before the guard (first answer, and the second if it was asked again). */
  raw: readonly string[];
}

export interface AskState {
  phase: AskPhase;
  ready: boolean;
  question: string | null;
  answer: AskAnswer | null;
  /** A limit, an interruption or a failure, in the reader's language. */
  message: string | null;
  /** A quick question waiting for the reader to say who they are. */
  pending: StarterId | null;
  donor: string | null;
}

export interface QuestionOpener {
  (locale: AgentLocale): Promise<{ questionId: string } | { limit: string; message: string }>;
}

/** POST /api/agent/question. */
export const serverQuestion =
  (endpoint = "/api/agent/question"): QuestionOpener =>
  async (locale) => {
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale }) });
    const body = (await res.json().catch(() => ({}))) as { questionId?: string; error?: string; message?: string };
    if (res.ok && body.questionId) return { questionId: body.questionId };
    return { limit: body.error ?? `http_${res.status}`, message: body.message ?? say("failed", locale) };
  };

export interface LedgerAgentOptions {
  getView: () => DriveView;
  locale?: () => AgentLocale;
  /** The model's side of a turn for each agent; live (Nova through /api/agent/turn) unless replaced. */
  modelFor?: (agentId: AgentId, live: { getQuestionId: () => string | null; locale: () => AgentLocale; onLimit: (code: string, message: string) => void }) => AgLlmAdapter;
  newQuestion?: QuestionOpener;
  history?: AgAiHistoryStore;
}

const lastAssistantText = (s: AgAiChatSession) => {
  const m = [...s.messages].reverse().find((x) => x.role === "assistant");
  return m ? m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
};

/**
 * The chat's controller: lives as long as the page, outlives each Studio. The book calls
 * `attach(api)` from Studio's onStudioReady; the widget reads `get()` and calls `ask`/`askStarter`.
 */
export class LedgerAgent {
  readonly facts: FactRegistry;
  readonly history: AgAiHistoryStore;
  private state: AskState = { phase: "idle", ready: false, question: null, answer: null, message: null, pending: null, donor: null };
  private readonly listeners = new Set<() => void>();
  private harness: AgAiHarness | null = null;
  private session: AgAiChatSession | null = null;
  private unlisten: (() => void) | null = null;
  private threadId: string | null = null;
  private generation = 0;
  private questionId: string | null = null;
  private outcome: GuardOutcome | null = null;
  private limit: { code: string; message: string } | null = null;
  private sawRunning = false;

  constructor(private readonly o: LedgerAgentOptions) {
    this.facts = new FactRegistry(() => o.getView().drive.baseCurrency);
    this.history = o.history ?? new MemoryHistory();
  }

  get = () => this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private set(next: Partial<AskState>) {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  private locale = (): AgentLocale => this.o.locale?.() ?? "en";

  private modelFor(agentId: AgentId, gen: number): AgLlmAdapter {
    const live = {
      getQuestionId: () => this.questionId,
      locale: this.locale,
      onLimit: (code: string, message: string) => {
        if (gen === this.generation) this.limit = { code, message };
      },
    };
    const model = this.o.modelFor ? this.o.modelFor(agentId, live) : novaAdapter({ agentId, ...live });
    if (agentId !== "ledger") return model;
    return guardedAdapter(model, {
      facts: () => this.facts.list(),
      locale: this.locale,
      onOutcome: (x) => {
        if (gen === this.generation) this.outcome = x;
      },
    });
  }

  /** A new Studio is ready: give it a harness, reopen the conversation, close the old one. */
  attach(api: AgStudioApi): () => void {
    const interrupted = this.state.phase === "thinking" || this.state.phase === "asking";
    this.detach();
    const gen = ++this.generation;
    const harness = attachLedgerAgent(api, { getView: this.o.getView, history: this.history, facts: this.facts, locale: this.locale, adapterFor: (id) => this.modelFor(id, gen) });
    this.harness = harness;
    if (interrupted) this.set({ phase: "interrupted", message: say("interrupted", this.locale()) });
    void (async () => {
      let session: AgAiChatSession;
      if (this.threadId) {
        // The roster loads from the history store asynchronously; opening before it lands fails (spike: 69 ms).
        const id = this.threadId;
        const t0 = Date.now();
        while (!harness.threads.some((t) => t.threadId === id) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
        session = harness.threads.some((t) => t.threadId === id) ? await harness.openThread(id) : await harness.createThread({ agentId: "ledger" });
      } else {
        session = await harness.createThread({ agentId: "ledger" });
      }
      if (gen !== this.generation) {
        session.close();
        return;
      }
      this.threadId = session.threadId;
      this.session = session;
      const onChange = () => this.onSession(gen);
      session.addEventListener("changed", onChange);
      this.unlisten = () => session.removeEventListener("changed", onChange);
      this.set({ ready: true });
    })().catch((e: unknown) => {
      if (gen === this.generation) this.set({ phase: "error", message: `${say("failed", this.locale())} (${e instanceof Error ? e.message : String(e)})` });
    });
    return () => {
      if (gen === this.generation) this.detach();
    };
  }

  /** Studio is going: close its session and harness. The conversation stays in the history store. */
  detach() {
    this.generation++;
    this.unlisten?.();
    this.unlisten = null;
    this.session?.close();
    this.session = null;
    this.harness?.dispose?.();
    this.harness = null;
    if (this.state.ready) this.set({ ready: false });
  }

  private onSession(gen: number) {
    const s = this.session;
    if (!s || gen !== this.generation || this.state.phase !== "thinking") return;
    if (s.status === "running") {
      this.sawRunning = true;
      return;
    }
    if (!this.sawRunning && !this.outcome && !this.limit) return;
    const base = { question: this.state.question ?? "", facts: [...this.facts.list()], source: "ai" as const, delegated: [...this.facts.delegated()] };
    if (this.limit) {
      this.set({ phase: "limit", message: this.limit.message, answer: null });
      return;
    }
    const o = this.outcome;
    if (s.status === "error" || !o) {
      this.set({ phase: "error", message: say("failed", this.locale()), answer: null });
      return;
    }
    const lineKeys = [...new Set(o.verdict.checked.flatMap((c) => linesFor(c, this.facts.list())))];
    this.set({
      phase: o.replaced ? "cannot" : "answered",
      message: null,
      answer: { ...base, text: o.text || lastAssistantText(s), verdict: o.verdict, retried: o.retried, replaced: o.replaced, lineKeys, raw: o.raw },
    });
  }

  /** A question in the reader's words, for the live agent. */
  async ask(text: string) {
    const question = text.trim();
    if (!question || !this.session || this.state.phase === "thinking" || this.state.phase === "asking") return;
    this.facts.reset();
    this.outcome = null;
    this.limit = null;
    this.sawRunning = false;
    this.set({ phase: "asking", question, answer: null, message: null, pending: null });
    const opened = await (this.o.newQuestion ?? serverQuestion())(this.locale());
    if ("limit" in opened) {
      this.set({ phase: "limit", message: opened.message });
      return;
    }
    this.questionId = opened.questionId;
    const session = this.session;
    if (!session) {
      this.set({ phase: "interrupted", message: say("interrupted", this.locale()) });
      return;
    }
    this.set({ phase: "thinking" });
    session.sendMessage(question);
  }

  /** A quick question: answered by the book's code, no model. */
  askStarter(id: StarterId, donor?: string | null) {
    const who = donor ?? this.state.donor;
    const s = STARTERS.find((x) => x.id === id)!;
    if (s.needsDonor && !who) {
      this.set({ phase: "who", pending: id, question: s.label[this.locale()], answer: null, message: null });
      return;
    }
    const a = answerStarter(this.o.getView(), id, who ?? null, this.locale());
    if (a.missing) {
      this.set({ phase: "who", pending: id, question: s.label[this.locale()], answer: null, message: null });
      return;
    }
    this.set({
      phase: "answered",
      pending: null,
      donor: who ?? this.state.donor,
      question: s.label[this.locale()],
      message: null,
      answer: { question: s.label[this.locale()], text: a.text, verdict: a.verdict, facts: a.facts, source: "code", delegated: [], retried: false, replaced: false, lineKeys: a.lineKeys, raw: [] },
    });
  }

  /** The reader said who they are; a waiting quick question is answered. */
  chooseDonor(donor: string) {
    const pending = this.state.pending;
    this.set({ donor });
    if (pending) this.askStarter(pending, donor);
  }

  /** "Ask again" after an interruption or a failure. */
  retry() {
    const q = this.state.question;
    if (!q) return;
    this.set({ phase: "idle" });
    void this.ask(q);
  }

  dispose() {
    this.detach();
    this.listeners.clear();
  }
}
