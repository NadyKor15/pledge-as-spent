"use client";

import { AgStudioAiModule, type AgLlmAdapter, type AgLlmResponse, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import closed from "../../../../tests/fixtures/drives/closed.json";
import { evalQuestions } from "../../../../eval/agent/questions";
import { afterComplete, novaAdapter } from "@/agent/adapter";
import { LedgerAgent } from "@/agent/harness";
import type { AgentLocale } from "@/agent/money-parse";
import { recordingAdapter, replayAdapter, type RecordedTurn } from "@/agent/recorded";
import { AskWidget } from "@/agent/ui/AskWidget";
import type { AgentId } from "@/agent/wire";
import { money } from "@/ui/format";
import { deriveLedger } from "@/ui/ledger/derive";
import { ledgerData } from "@/ui/ledger/studio-state";
import type { DriveView } from "@/ui/types";

// Debug page of the live agent. Not product code: the book lane owns the real Ledger page; this page
// stands in for it (a plain table for the "narrowed" book) so the agent can be run and photographed.

const VIEW = closed as unknown as DriveView;

type Mode = "script" | "recorded" | "live";

interface Recording {
  id: string;
  question: string;
  locale: AgentLocale;
  turns: RecordedTurn[];
}

declare global {
  interface Window {
    __agentDebug?: Record<string, unknown>;
  }
}

/** A fixed play with no model: our agent reads Mark's money, asks the data agent for water, answers. `bad` plants a made-up figure. */
function scripted(agentId: AgentId, bad: boolean): AgLlmAdapter {
  let n = 0;
  const call = (name: string, args: object): AgLlmResponse["output"] => [{ id: `fc${n}`, kind: "output", type: "function_call", callId: `${agentId}-call${n}`, name, arguments: JSON.stringify(args) }];
  const say = (text: string): AgLlmResponse["output"] => [{ id: `m${n}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }];
  return {
    executeTurn() {
      const i = n++;
      let output: AgLlmResponse["output"];
      if (agentId === "data") {
        if (i === 0) output = call("view_schema", {});
        else if (i === 1)
          output = call("execute_query", {
            query: { variant: "aggregation", kind: "apiQuery", axes: [{ dimensions: [{ field: { id: "book.need" } }] }], measures: [{ field: { id: "book.share", aggregation: "sum" } }], filter: { field: { id: "book.need" }, operator: "equals", value: "Water 2 L" } },
          });
        else output = call("complete_task", { summary: "Water 2 L: the sum of @field[book.share] is 1486 (¥1,500 by my count).", artifacts: [] });
      } else {
        if (i === 0) output = call("ledger_donor_money", { donor: "Mark" });
        else if (i === 1) output = call("delegate_to", { type: { id: "data" }, instructions: "Sum the book's Share field for the need Water 2 L." });
        else output = say(bad ? "<thinking>add them</thinking>Your $30.00 hold paid $21.47 for diapers." : "<thinking>copy</thinking>Your $30.00 hold paid $21.45 for baby diapers size M: lines $8.58, $10.89 and $1.98, PayPal capture 5PE922386K0983923. The other $8.55 was released when the drive closed. Water got ¥1,486 across all donors.");
      }
      return afterComplete(new Promise((res) => setTimeout(() => res({ id: `r${i}`, createdAt: Date.now(), status: "completed", output }), 120)));
    },
  };
}

const STATE: AgReportState = {
  selectedPageId: "p",
  pages: [
    {
      id: "p",
      widgets: { book: { type: "grid", dataMapping: { cols: ["line", "item", "need", "payer", "share", "capture", "status", "order"].map((c) => ({ id: `book.${c}` })) }, format: { title: { enabled: false } } } } as never,
      widgetLayout: { book: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 30 } },
    },
  ],
};

const noSubscribe = () => () => {};

function useParams() {
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => null);
  return search === null ? null : new URLSearchParams(search);
}

let localQuestions = 0;

export function AgentDebug() {
  const params = useParams();
  if (!params) return null;
  return <Debug mode={(params.get("mode") as Mode) ?? "script"} q={params.get("q") ?? "Q1"} lang={(params.get("lang") as AgentLocale) ?? null} bad={params.get("bad") === "1"} auto={params.get("auto") === "1"} />;
}

function Debug({ mode, q, lang, bad, auto }: { mode: Mode; q: string; lang: AgentLocale | null; bad: boolean; auto: boolean }) {
  const model = useMemo(() => deriveLedger(VIEW), []);
  const data = useMemo(() => ledgerData(model), [model]);
  const question = useMemo(() => evalQuestions(VIEW).find((x) => x.id === q.replace(/-.*/, "")), [q]);
  const [recording, setRecording] = useState<Recording | null | "missing">(mode === "recorded" ? null : "missing");
  const locale: AgentLocale = lang ?? (recording && recording !== "missing" ? recording.locale : question?.locale) ?? "en";
  const [turns] = useState<RecordedTurn[]>([]);
  const [mount, setMount] = useState(0);
  const [focus, setFocus] = useState<{ lineKeys: string[]; label: string } | null>(null);

  useEffect(() => {
    if (mode !== "recorded") return;
    void fetch(`/debug/agent-spike/recorded?q=${encodeURIComponent(q)}`).then(async (r) => setRecording(r.ok ? ((await r.json()) as Recording) : "missing"));
  }, [mode, q]);

  const agent = useMemo(() => {
    if (mode === "recorded" && (recording === null || recording === "missing")) return null;
    const rec = recording && recording !== "missing" ? recording : null;
    return new LedgerAgent({
      getView: () => VIEW,
      locale: () => locale,
      newQuestion: mode === "live" ? undefined : async () => ({ questionId: `local-question-${++localQuestions}` }),
      modelFor: (agentId, live) => {
        if (mode === "recorded") return replayAdapter(rec!.turns, agentId);
        if (mode === "script") return scripted(agentId, bad);
        return recordingAdapter(novaAdapter({ agentId, ...live }), agentId, (t) => turns.push(t));
      },
    });
  }, [mode, recording, locale, bad, turns]);

  const state = useSyncExternalStore(
    useCallback((l: () => void) => agent?.subscribe(l) ?? (() => {}), [agent]),
    () => agent?.get() ?? null,
    () => null,
  );

  useEffect(() => {
    if (!agent) return;
    window.__agentDebug = {
      mode,
      q,
      locale,
      question: question?.text,
      turns,
      state: () => agent.get(),
      toolRuns: () => agent.facts.toolRuns(),
      facts: () => agent.facts.list(),
      ask: (text: string) => agent.ask(text),
      remount: () => setMount((m) => m + 1),
    };
  });

  const asked = useRef(false);
  useEffect(() => {
    if (!auto || !agent || !state?.ready || asked.current) return;
    asked.current = true;
    const text = recording && recording !== "missing" ? recording.question : (question?.text ?? "");
    void agent.ask(text);
  }, [auto, agent, state?.ready, recording, question]);

  const donors = useMemo(() => VIEW.holds.filter((h) => h.kind === "donor").map((h) => ({ name: h.donorName, label: h.donorName.replace(/\s*\((.+)\)/, " · $1") })), []);
  const rows = focus ? model.book.filter((r) => focus.lineKeys.includes(r.lineKey)) : model.book;

  if (mode === "recorded" && recording === "missing") return <p style={{ fontFamily: "monospace", padding: 16 }}>No recording {q}.</p>;
  if (!agent) return null;

  return (
    <main className="dbg">
      <style>{CSS}</style>
      <header className="dbg-top">
        <b className="dbg-brand">Pledge-as-Spent</b>
        <span className="dbg-shelter">Kitasora Community Shelter</span>
        <span className="dbg-tag">Fictional drive · PayPal Sandbox</span>
        <span className="dbg-mode" data-testid="dbg-mode">
          {mode}
          {mode === "recorded" ? ` ${q}` : ""}
        </span>
      </header>
      <section className="dbg-kpis">
        <div>
          <span>Pledged</span>
          <b>{money(model.baseCurrency, model.promised)}</b>
        </div>
        <div>
          <span>{model.spentLabel}</span>
          <b className="dbg-green">{money(model.baseCurrency, model.spent)}</b>
        </div>
        <div>
          <span>Returned</span>
          <b className="dbg-blue">{money(model.baseCurrency, model.rest)}</b>
        </div>
      </section>

      <AskWidget agent={agent} locale={locale} donors={donors} onFocusLines={(lineKeys, label) => setFocus({ lineKeys, label })} />

      <section className="dbg-book" data-testid="dbg-book">
        <header>
          <h2>The book</h2>
          {focus && (
            <button type="button" className="dbg-narrow" onClick={() => setFocus(null)} data-testid="dbg-narrow">
              Narrowed by the assistant: {focus.label} <span aria-hidden="true">×</span>
            </button>
          )}
        </header>
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>Item</th>
              <th>Need</th>
              <th>Payer</th>
              <th>Share</th>
              <th>PayPal capture</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.lineKey}-${r.order}`} className={focus ? "dbg-hit" : undefined}>
                <td>{r.line}</td>
                <td>{r.item}</td>
                <td>{r.need}</td>
                <td>{r.payer}</td>
                <td>{r.charged !== "—" ? r.charged : money(model.baseCurrency, r.share)}</td>
                <td className="dbg-mono">{r.capture}</td>
                <td>
                  <span className={`dbg-pill dbg-pill-${r.status === "Spent" ? "spent" : r.status === "Refused" ? "refused" : "other"}`}>{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dbg-studio">
        <p>
          AG Studio (view mode) — the book the agents query · mount {mount}{" "}
          <button type="button" onClick={() => setMount((m) => m + 1)} data-testid="dbg-remount">
            Rebuild Studio
          </button>
        </p>
        <AgStudioProvider modules={[AgStudioAiModule]}>
          <div style={{ height: 320 }}>
            <AgStudio key={mount} style={{ width: "100%", height: "100%" }} data={data} initialState={STATE} mode="view" panels={{ view: { left: [], right: [] }, edit: { left: [], right: [] } }} onStudioReady={(e: { api: AgStudioApi }) => void agent.attach(e.api)} />
          </div>
        </AgStudioProvider>
      </section>
    </main>
  );
}

const CSS = `
body { background: #f5f4f0; margin: 0; }
.dbg { font-family: Inter, system-ui, sans-serif; color: #1c1b19; max-width: 1560px; margin: 0 auto; padding: 18px 24px 40px; display: flex; flex-direction: column; gap: 18px; }
.dbg-top { display: flex; align-items: center; gap: 22px; border-bottom: 1px solid #e2e4e1; padding-bottom: 12px; }
.dbg-brand { font-size: 30px; color: #0f5c55; letter-spacing: -0.01em; }
.dbg-shelter { font-size: 22px; font-weight: 650; border-left: 1px solid #cfd2ce; padding-left: 22px; }
.dbg-tag { background: #e3ece9; border-radius: 8px; padding: 6px 14px; font-size: 16px; }
.dbg-mode { margin-left: auto; font: 12px monospace; color: #888; }
.dbg-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; }
.dbg-kpis div { padding: 4px 24px; border-left: 1px solid #e2e4e1; display: flex; flex-direction: column; }
.dbg-kpis div:first-child { border-left: 0; }
.dbg-kpis span { font-size: 21px; color: #3c4250; }
.dbg-kpis b { font-size: 44px; }
.dbg-green { color: #2f855a; }
.dbg-blue { color: #0a74c9; }
.dbg-book { background: #fff; border: 1px solid #e2e4e1; border-radius: 14px; padding: 18px 24px; }
.dbg-book header { display: flex; align-items: center; gap: 20px; margin-bottom: 12px; }
.dbg-book h2 { margin: 0; font-size: 30px; border-left: 5px solid #137a76; padding-left: 14px; }
.dbg-narrow { font: inherit; font-size: 16px; background: #dcefef; border: 0; border-radius: 10px; padding: 7px 16px; cursor: pointer; }
.dbg-book table { width: 100%; border-collapse: collapse; font-size: 17px; }
.dbg-book th { text-align: left; font-weight: 600; color: #3c4250; background: #f3f3f1; padding: 10px 14px; }
.dbg-book td { padding: 9px 14px; border-top: 1px solid #ecedea; }
.dbg-hit td { background: #eef7f0; }
.dbg-mono { font-family: ui-monospace, Menlo, monospace; font-size: 15px; }
.dbg-pill { display: inline-block; border-radius: 999px; padding: 2px 14px; font-size: 15px; font-weight: 600; }
.dbg-pill-spent { background: #2f855a; color: #fff; }
.dbg-pill-refused { background: #fbe4e8; color: #b0213f; }
.dbg-pill-other { background: #eee; }
.dbg-studio { background: #fff; border: 1px dashed #c9cdc8; border-radius: 10px; padding: 8px 12px; font-size: 13px; color: #666; }
`;
