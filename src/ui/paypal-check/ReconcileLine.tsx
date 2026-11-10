"use client";

import { useEffect, useState } from "react";
import type { Reconciliation } from "@/server/reconcile";
import { api } from "../api";
import type { Lang } from "../format";
import { reconcileLine } from "../reconcile-words";
import "./reconcile.css";

// The daily check with PayPal, as one line beside "Ask PayPal yourself": when the server last asked PayPal, how many
// objects, how many differences, and each difference by name. It reads what the server kept
// (GET /api/drives/[id]/reconcile) and never asks PayPal itself. Until the answer is in, or if it cannot be read,
// the line makes no claim at all.

type State = { kind: "loading" } | { kind: "done"; last: Reconciliation | null } | { kind: "error" };

export function ReconcileLine({ driveId, lang = "en", variant }: { driveId: string; lang?: Lang; variant: "ledger" | "statement" }) {
  const [state, setState] = useState<State>({ kind: "loading" });

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
  const list =
    line.items.length > 0 ? (
      <ul className="rc-list" data-testid="reconcile-differences">
        {line.items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    ) : null;
  const text = (
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

  return (
    <div className={cls} data-testid="reconcile-line" data-state={line.state} lang={lang} title={line.about}>
      {list && variant === "ledger" ? (
        // In the Ledger's bottom line there is no room for a list: it opens over the report, nothing is hidden.
        <details className="rc-more">
          <summary className="rc-text">{text}</summary>
          {list}
        </details>
      ) : (
        <>
          <p className="rc-text">{text}</p>
          {list}
        </>
      )}
    </div>
  );
}
