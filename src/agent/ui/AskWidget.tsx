"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ASK_ANCHOR } from "@/ui/header-words";
import { checkAnswer, linesFor, type Claim } from "../guard";
import { say } from "../i18n";
import type { AskState } from "../harness";
import { planLabel } from "../model-plan";
import type { AgentLocale } from "../money-parse";
import { STARTERS, type StarterId } from "../starters";
import { delegationText } from "../steps";
import type { Fact } from "../types";
import "./ask.css";

// "Ask the book" (design ASK-B2, Nadya's pick). The answer is large; every figure the book
// confirms is a green chip inside the sentence; pressing one narrows the book to its lines. Under
// the answer one line says how many figures were checked — the row of chips the picture repeats
// under the answer is left out on purpose.

export interface AskAgent {
  get(): AskState;
  subscribe(listener: () => void): () => void;
  /** True when the agent took the question; false (nothing changed) when it cannot take one now. */
  ask(text: string): boolean;
  askStarter(id: StarterId, donor?: string | null): void;
  chooseDonor(donor: string): void;
  retry(): boolean;
}

export interface AskWidgetProps {
  agent: AskAgent;
  locale?: AgentLocale;
  /** Donors to pick from when a quick question needs to know who is asking. */
  donors: { name: string; label: string }[];
  /** Narrow the book to these lines (the book's store.focusLines). */
  onFocusLines?: (lineKeys: string[], label: string) => void;
  /** Small print beside the model's name (the WebMCP badge). */
  footExtra?: ReactNode;
}

const UI = {
  title: { en: "Ask the book", de: "Frag das Buch", ja: "帳簿にきく" },
  sub: { en: "Answers come only from the book. Every figure is checked.", de: "Antworten kommen nur aus dem Buch. Jede Zahl wird geprüft.", ja: "答えは帳簿だけから。金額はすべて照合済みです。" },
  placeholder: { en: "Ask about any line…", de: "Fragen Sie zu jeder Zeile…", ja: "どの行についても質問できます…" },
  send: { en: "Ask", de: "Fragen", ja: "質問" },
  foot: { en: "read-only · it cannot move money", de: "nur lesend · kann kein Geld bewegen", ja: "読み取り専用 · お金は動かせません" },
  checked: { en: "Checked against the book", de: "Mit dem Buch abgeglichen", ja: "帳簿と照合" },
  code: { en: "answered by the book's code, no AI", de: "vom Code des Buchs beantwortet, ohne KI", ja: "帳簿のコードが回答（AIなし）" },
  thinking: { en: "Reading the book…", de: "Lese das Buch…", ja: "帳簿を確認中…" },
  who: { en: "Who are you in the book?", de: "Wer sind Sie im Buch?", ja: "帳簿のどなたですか？" },
  noFigures: { en: "no figures to check", de: "keine Beträge zu prüfen", ja: "照合する金額なし" },
  withheld: {
    en: "The answer had a figure the book does not hold, so it is not shown.",
    de: "Die Antwort enthielt einen Betrag, den das Buch nicht kennt; sie wird nicht gezeigt.",
    ja: "回答に帳簿にない金額が含まれていたため、表示していません。",
  },
} as const;

function Robot() {
  return (
    <svg className="ask-robot" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9.5" cy="13.5" r="1.4" fill="currentColor" />
      <circle cx="14.5" cy="13.5" r="1.4" fill="currentColor" />
      <path d="M12 8V5M12 5a1 1 0 1 0 0-.01M2.5 12v3M21.5 12v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Send() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M3.5 11.6 20 4.2c.5-.2 1 .3.8.8l-7.4 16.5c-.2.5-1 .5-1.1 0l-1.9-6.7-6.7-1.9c-.5-.1-.6-.9-.1-1.1Z M10.4 13.6 20.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

const ofText = (n: number, of: number, l: AgentLocale) => (l === "de" ? `${n} von ${of}` : l === "ja" ? `${of}件中${n}件` : `${n} of ${of}`);

/** "Mark (Columbus, US)" from the facts of a donor answer; the book's chip says who it was narrowed to. */
function subjectOf(facts: readonly Fact[]): string | null {
  const f = facts.find((x) => / pledged$/.test(x.label));
  return f ? f.label.replace(/ pledged$/, "").replace(/\s*\(([^,)]+)(?:, [A-Z]{2})?\)/, " · $1") : null;
}

/** The sentence with each confirmed figure as a chip in place. */
function withChips(text: string, claims: Claim[], chip: (c: Claim, i: number) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  claims.forEach((c, i) => {
    if (c.start > at) out.push(text.slice(at, c.start));
    out.push(chip(c, i));
    at = c.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function AskWidget({ agent, locale = "en", donors, onFocusLines, footExtra }: AskWidgetProps) {
  const s = useSyncExternalStore(agent.subscribe, agent.get, agent.get);
  const [draft, setDraft] = useState("");
  const last = useRef<unknown>(null);
  const box = useRef<HTMLElement>(null);

  // In the book's slot the chat has a fixed height and scrolls inside: a question and its answer are brought into
  // view there, without moving the page.
  useEffect(() => {
    const el = box.current;
    const q = el?.querySelector<HTMLElement>('[data-testid="ask-question"]');
    if (!el || !q || el.scrollHeight <= el.clientHeight) return;
    el.scrollTop += q.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
  }, [s.phase, s.answer]);

  // A new answer narrows the book to its lines, as the picture shows ("Narrowed by the assistant").
  useEffect(() => {
    const a = s.answer;
    if (!a || a === last.current) return;
    last.current = a;
    if (a.lineKeys.length && onFocusLines) onFocusLines([...a.lineKeys], subjectOf(a.facts) ?? a.question);
  }, [s.answer, onFocusLines]);

  const busy = s.phase === "asking" || s.phase === "thinking";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy || !s.ready) return;
    // Cleared only when the agent took the question: refused (Studio being built again), the words stay.
    if (agent.ask(draft)) setDraft("");
  };

  const answer = s.answer;
  const verdict = answer ? checkAnswer(answer.text, answer.facts, locale) : null;

  return (
    <section className="ask" ref={box} id={ASK_ANCHOR} data-phase={s.phase} data-ready={s.ready} data-testid="ask-widget" lang={locale}>
      <header className="ask-head">
        <h2>{UI.title[locale]}</h2>
        <p>{UI.sub[locale]}</p>
      </header>

      <div className="ask-starters" role="group" aria-label={UI.title[locale]}>
        {STARTERS.map((st) => (
          <button key={st.id} type="button" className="ask-starter" disabled={busy} onClick={() => agent.askStarter(st.id)} data-testid={`ask-starter-${st.id}`}>
            {st.label[locale]}
          </button>
        ))}
      </div>

      {s.question && s.phase !== "idle" && (
        <p className="ask-question" data-testid="ask-question">
          {s.question}
        </p>
      )}

      {s.phase === "who" && (
        <div className="ask-who">
          <span>{UI.who[locale]}</span>
          {donors.map((d) => (
            <button key={d.name} type="button" className="ask-starter" onClick={() => agent.chooseDonor(d.name)}>
              {d.label}
            </button>
          ))}
        </div>
      )}

      {answer?.step && (
        <p className="ask-step" data-testid="ask-step">
          <Robot />
          <span>{delegationText(answer.step, locale)}</span>
        </p>
      )}

      {busy && (
        <p className="ask-thinking" aria-live="polite">
          <span className="ask-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {UI.thinking[locale]}
        </p>
      )}

      {answer && verdict && (s.phase === "answered" || s.phase === "cannot") && (
        <div className="ask-answer-wrap" aria-live="polite">
          <p className={`ask-answer${answer.replaced ? " ask-answer-cannot" : ""}`} data-testid="ask-answer">
            {withChips(answer.text, verdict.checked, (c, i) => {
              const lines = linesFor(c, answer.facts);
              return (
                <button
                  key={`${c.start}-${i}`}
                  type="button"
                  className="ask-chip"
                  data-testid="ask-chip"
                  title={lines.length ? undefined : UI.checked[locale]}
                  onClick={() => lines.length && onFocusLines?.(lines, c.raw.trim())}
                >
                  <span aria-hidden="true">✓</span>
                  {c.raw.trim()}
                </button>
              );
            })}
          </p>
          <p className="ask-checked" data-testid="ask-checked">
            {answer.replaced ? UI.withheld[locale] : `${UI.checked[locale]} · ${verdict.checked.length ? ofText(verdict.checked.length, verdict.checked.length + verdict.unmatched.length, locale) : UI.noFigures[locale]}`}
            {answer.source === "code" && <span className="ask-code"> · {UI.code[locale]}</span>}
          </p>
        </div>
      )}

      {(s.phase === "limit" || s.phase === "interrupted" || s.phase === "error") && s.message && (
        <div className={`ask-note ask-note-${s.phase}`} data-testid="ask-note" aria-live="polite">
          <p>{s.message}</p>
          {(s.phase === "interrupted" || s.phase === "error") && (
            <button type="button" className="ask-again" disabled={!s.ready} onClick={() => agent.retry()}>
              {say("askAgain", locale)}
            </button>
          )}
        </div>
      )}

      <form className="ask-form" onSubmit={submit}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={UI.placeholder[locale]} aria-label={UI.placeholder[locale]} data-testid="ask-input" maxLength={500} />
        <button type="submit" className="ask-send" disabled={busy || !s.ready || !draft.trim()} aria-label={UI.send[locale]} data-testid="ask-send">
          <Send />
        </button>
      </form>
      <div className="ask-foot">
        <p data-testid="ask-model">
          {s.modelLabel ?? planLabel(s.modelPlan, locale)} · {UI.foot[locale]}
        </p>
        {footExtra}
      </div>
    </section>
  );
}
