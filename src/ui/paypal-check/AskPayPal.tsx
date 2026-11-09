"use client";

import { useRef, useState } from "react";
import type { CheckResult, CheckRow } from "@/server/paypal-check";
import { api, asApiError, type ApiError } from "../api";
import { moneyIn, type Lang } from "../format";
import { rowsFor, utc } from "./rows";
import { CHECK_WORDS } from "./words";
import "./paypal-check.css";

// "Ask PayPal yourself": a button that opens a dialog and asks the server to read the drive's holds, captures and
// payouts back from PayPal's sandbox (GET only). The dialog sits in the browser's top layer, so it never moves the
// page it is opened from (the Ledger's report, the statement).

type State = { kind: "idle" } | { kind: "asking" } | { kind: "done"; result: CheckResult } | { kind: "error"; error: ApiError };

const MARK: Record<CheckRow["verdict"], string> = { agrees: "✓", differs: "✗", ahead: "…", no_answer: "?" };

export function AskPayPal({ driveId, lang = "en", focus, className, testId }: { driveId: string; lang?: Lang; focus?: { pledgeId: string; receiptIds: string[] }; className?: string; testId?: string }) {
  const w = CHECK_WORDS[lang];
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [all, setAll] = useState(false);
  const url = `/api/drives/${encodeURIComponent(driveId)}/paypal-check`;

  const ask = async () => {
    setState({ kind: "asking" });
    try {
      setState({ kind: "done", result: await api<CheckResult>(url) });
    } catch (e) {
      setState({ kind: "error", error: asApiError(e) });
    }
  };
  const open = () => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    if (state.kind !== "asking") void ask();
  };

  const result = state.kind === "done" ? state.result : null;
  const shown = result ? (all ? result.rows : rowsFor(result.rows, focus)) : [];
  const answered = shown.filter((r) => r.paypal.http === 200).length;
  const agree = shown.filter((r) => r.verdict === "agrees").length;
  const narrowed = result !== null && focus !== undefined && !all && shown.length < result.rows.length;

  return (
    <>
      <button type="button" className={className ?? "pc-open"} onClick={open} data-testid={testId ?? "ask-paypal"}>
        {w.button}
      </button>
      <dialog ref={dialog} className="pc-dialog" lang={lang} aria-labelledby={`pc-title-${driveId}`} onClose={() => setAll(false)}>
        <div className="pc-head">
          <h2 id={`pc-title-${driveId}`}>{w.title}</h2>
          <button type="button" className="pc-x" aria-label={w.close} onClick={() => dialog.current?.close()}>
            ×
          </button>
        </div>
        <p className="pc-lead">{w.lead}</p>

        {state.kind === "asking" && (
          <p className="pc-wait" role="status">
            {w.asking}
          </p>
        )}

        {state.kind === "error" && (
          <div className="pc-error" role="alert">
            <p>{state.error.code === "paypal_no_answer" || state.error.status === 0 ? w.noAnswer : state.error.message}</p>
          </div>
        )}

        {result && (
          <>
            <p className="pc-sum" role="status" data-testid="paypal-check-sum">
              <b>{w.answered(answered, shown.length)}</b>
              <span> · {w.agree(agree)}</span>
            </p>
            <p className="pc-honest">
              {w.honest} {result.cached ? w.kept(utc(result.askedAt), result.keptForS) : w.askedAt(utc(result.askedAt))}
            </p>
            {narrowed && (
              <p className="pc-narrow">
                Your hold, its captures and the volunteer payouts your money went to.{" "}
                <button type="button" className="pc-link" onClick={() => setAll(true)}>
                  Show all {result.rows.length} objects of this drive
                </button>
              </p>
            )}
            <div className="pc-table" role="table" aria-label={w.title}>
              <div className="pc-row pc-th" role="row">
                <span role="columnheader">{w.col.object}</span>
                <span role="columnheader">{w.col.book}</span>
                <span role="columnheader">{w.col.paypal}</span>
                <span role="columnheader" className="pc-mcol">
                  {w.col.match}
                </span>
              </div>
              {shown.map((r) => (
                <Row key={`${r.kind}:${r.id}`} row={r} lang={lang} />
              ))}
            </div>
            <p className="pc-foot">
              <a href={url} target="_blank" rel="noopener noreferrer">
                {w.allJson}
              </a>{" "}
              · {w.hidden}
            </p>
          </>
        )}

        <div className="pc-acts">
          <button type="button" className="pc-again" disabled={state.kind === "asking"} onClick={() => void ask()}>
            {w.again}
          </button>
          <button type="button" className="pc-close" onClick={() => dialog.current?.close()}>
            {w.close}
          </button>
        </div>
      </dialog>
    </>
  );
}

function Row({ row: r, lang }: { row: CheckRow; lang: Lang }) {
  const w = CHECK_WORDS[lang];
  const amount = (m: { currency: string; minor: number } | null) => (m ? moneyIn(lang, m.currency, m.minor) : null);
  const p = r.paypal;
  const said = r.kind === "payout" && p.itemStatus ? `${p.status ?? "–"} · ${w.item} ${p.itemStatus}` : (p.status ?? (p.http ? `HTTP ${p.http}` : w.verdict.no_answer));
  return (
    <div className={`pc-row pc-${r.verdict}`} role="row" data-kind={r.kind} data-verdict={r.verdict}>
      <span role="cell" className="pc-obj">
        <b>{w.kind[r.kind]}</b> <span className="pc-who">{r.who}</span>
        <code className="pc-id">{r.id}</code>
      </span>
      <span role="cell" className="pc-book" data-head={w.col.book}>
        <span>{w.state[r.book.state] ?? r.book.state}</span>
        <span className="pc-amt">{amount(r.book.amount) ?? w.noAmount}</span>
      </span>
      <span role="cell" className="pc-pp" data-head={w.col.paypal}>
        <span className="pc-status">{said}</span>
        {p.amount && <span className="pc-amt">{amount(p.amount)}</span>}
        <span className="pc-times">
          {p.created && (
            <>
              {w.created} {utc(p.created)}
            </>
          )}
          {p.updated && (
            <>
              <br />
              {r.kind === "payout" ? w.completed : w.updated} {utc(p.updated)}
            </>
          )}
        </span>
        {r.raw !== null && (
          <details className="pc-json">
            <summary>{w.json}</summary>
            <pre>
              {r.request}
              {"\n"}
              {JSON.stringify(r.raw, null, 2)}
            </pre>
          </details>
        )}
      </span>
      <span role="cell" className="pc-mark" title={w.verdict[r.verdict]}>
        <span aria-hidden="true">{MARK[r.verdict]}</span>
        <span className="pc-sr">{w.verdict[r.verdict]}</span>
      </span>
    </div>
  );
}
