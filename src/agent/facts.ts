import type { AgAiTelemetryEvent, AgAiTelemetryObserver } from "ag-studio";
import { isNeedSumQuery, type DelegationStep } from "./steps";
import type { Fact } from "./types";

// Which figures the book has returned while answering the current question. Fed by Studio's
// telemetry, which reports every tool call, the data agent's calls under delegation included.
// Facts come from our `ledger_*` tools (their `data.facts`) and from Studio's `execute_query`
// (the numbers in its result rows). A delegate's `complete_task` summary is written by a model, and
// `delegate_to` returns only that summary: neither is a fact.

export interface ToolRun {
  /** Which agent ran the tool: `ledger`, or `data` under delegation. */
  agentId: string;
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
}

/** `data.facts` of a `ledger_*` tool result (Studio serialises `{success, response, data}`). */
export function factsFromLedgerResult(result: string): Fact[] {
  try {
    const r = JSON.parse(result) as { success?: boolean; data?: { facts?: Fact[] } };
    return r.success && Array.isArray(r.data?.facts) ? r.data.facts.filter((f) => typeof f.value === "number") : [];
  } catch {
    return [];
  }
}

/** Columns of an execute_query row that hold counts or positions, not money. */
const NOT_MONEY = /count|line|order|qty|row|^n$/i;

/** Numbers in `execute_query` result rows: each as a bare figure, and in the drive's currency unless the column is a count. */
export function factsFromQueryResult(result: string, baseCurrency: string): Fact[] {
  let rows: Record<string, unknown>[] = [];
  try {
    const r = JSON.parse(result) as { success?: boolean; data?: { result?: Record<string, unknown>[] } };
    if (r.success && Array.isArray(r.data?.result)) rows = r.data.result;
  } catch {
    return [];
  }
  const facts: Fact[] = [];
  for (const row of rows) {
    for (const [col, v] of Object.entries(row)) {
      const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!Number.isFinite(n)) continue;
      facts.push({ value: n, label: `query ${col}` });
      if (!NOT_MONEY.test(col)) facts.push({ value: n, currency: baseCurrency, label: `query ${col}` });
    }
  }
  return facts;
}

export class FactRegistry {
  private facts: Fact[] = [];
  private runs: ToolRun[] = [];
  private delegations: string[] = [];
  private readonly started = new Map<string, { args: unknown; agentId: string; name: string }>();

  constructor(private readonly baseCurrency: () => string) {}

  /** A new question: nothing confirmed yet. */
  reset() {
    this.facts = [];
    this.runs = [];
    this.delegations = [];
    this.started.clear();
  }

  list(): readonly Fact[] {
    return this.facts;
  }

  toolRuns(): readonly ToolRun[] {
    return this.runs;
  }

  /** What our agent asked Studio's data agent, in its own words, for each delegation of this question. For the measure only: never shown. */
  delegated(): readonly string[] {
    return this.delegations;
  }

  /** What the reader is told about the delegation: by what the data agent ran, not by the model's words. Null when there was none. */
  delegationStep(): DelegationStep | null {
    if (!this.delegations.length) return null;
    const ranNeedSum = [...this.started.values()].some((s) => s.agentId === "data" && s.name === "execute_query" && isNeedSumQuery((s.args as { query?: unknown } | undefined)?.query));
    return ranNeedSum ? "needSum" : "query";
  }

  /** Facts added by hand: an answer computed by the book's code. */
  add(facts: readonly Fact[]) {
    this.facts.push(...facts);
  }

  readonly observer: AgAiTelemetryObserver = { onEvent: (e) => this.onEvent(e) };

  onEvent(e: AgAiTelemetryEvent) {
    if (e.type === "tool_execution_started") {
      this.started.set(e.toolCallId, { args: e.args, agentId: e.trace.agentId, name: e.name });
      if (e.name === "delegate_to") {
        const a = e.args as { instructions?: string } | undefined;
        this.delegations.push(typeof a?.instructions === "string" ? a.instructions : "");
      }
      return;
    }
    if (e.type !== "tool_execution_finished") return;
    const s = this.started.get(e.toolCallId);
    this.runs.push({ agentId: s?.agentId ?? e.trace.agentId, name: e.name, args: s?.args, ok: e.ok, result: e.result ?? "" });
    if (!e.ok || !e.result) return;
    if (e.name.startsWith("ledger_")) this.facts.push(...factsFromLedgerResult(e.result));
    else if (e.name === "execute_query") this.facts.push(...factsFromQueryResult(e.result, this.baseCurrency()));
  }
}
