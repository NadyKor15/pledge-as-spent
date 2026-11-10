"use client";

import { useEffect, useRef, useState } from "react";
import type { Reconciliation } from "@/server/reconcile";
import { api } from "../api";
import type { Lang } from "../format";
import { RECONCILE_WORDS, reconcileLine, type ReconcileLineModel } from "../reconcile-words";
import { CHECK_WORDS } from "./words";
import "./paypal-check.css";
import "./reconcile.css";

// The daily check with PayPal, as one line beside "Ask PayPal yourself": when the server last asked PayPal, how many
// objects, how many differences, and each difference by name. It reads what the server kept
// (GET /api/drives/[id]/reconcile) and never asks PayPal itself. Until the answer is in, or if it cannot be read,
// the line makes no claim at all.

type State = { kind: "loading" } | { kind: "done"; last: Reconciliation | null } | { kind: "error" };

function LineText({ line }: { line: ReconcileLineModel }) {
  return (
    <>
      {line.state === "clean" && (
        <span className="rc-mark" aria-hidden="true">
          ✓{" "}
        </span>
      )}
      {line.head}
      {line.when && (
        <>
          {" · "}
          <time dateTime={line.when.iso}>{line.when.text}</time>
        </>
      )}
      {line.counts.map((c) => (
        <span key={c}> · {c}</span>
      ))}
    </>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="rc-list" data-testid="reconcile-differences">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

export function ReconcileLine({ driveId, lang = "en", variant }: { driveId: string; lang?: Lang; variant: "ledger" | "statement" }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let live = true;
    api<{ last: Reconciliation | null }>(`/api/drives/${encodeURIComponent(driveId)}/reconcile`).then(
      (body) => {
        if (live) setState({ kind: "done", last: body.last });
      },
      () => {
        if (live) setState({ kind: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [driveId]);

  const cls = `rc rc-${variant}`;
  // A line's height kept while the answer is on its way, so nothing under it moves.
  if (state.kind !== "done") return <p className={`${cls} rc-wait`} aria-hidden="true" />;

  const line = reconcileLine(state.last, lang);
  const listed = line.items.length > 0;

  if (variant === "statement" || !listed) {
    return (
      <div className={cls} data-testid="reconcile-line" data-state={line.state} lang={lang}>
        <p className="rc-text" title={line.about}>
          <LineText line={line} />
        </p>
        {listed && <List items={line.items} />}
      </div>
    );
  }

  // The Ledger's bottom line is a widget that clips what leaves it: the list opens in the browser's top layer, as
  // "Ask PayPal yourself" does, so nothing of it is ever hidden.
  const titleId = `rc-title-${driveId}`;
  return (
    <div className={cls} data-testid="reconcile-line" data-state={line.state} lang={lang}>
      <button type="button" className="rc-text rc-open" aria-haspopup="dialog" title={line.about} onClick={() => dialog.current?.showModal()}>
        <LineText line={line} />
      </button>
      <dialog ref={dialog} className="pc-dialog rc-dialog" lang={lang} aria-labelledby={titleId} data-testid="reconcile-dialog">
        <div className="pc-head">
          <h2 id={titleId}>{RECONCILE_WORDS[lang].checked}</h2>
          <button type="button" className="pc-x" aria-label={CHECK_WORDS[lang].close} onClick={() => dialog.current?.close()}>
            ×
          </button>
        </div>
        <p className="rc-sum">
          <LineText line={line} />
        </p>
        <List items={line.items} />
        <p className="pc-lead rc-about">{line.about}</p>
      </dialog>
    </div>
  );
}
