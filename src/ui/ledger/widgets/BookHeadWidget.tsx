"use client";

import type { AgWidgetParams } from "ag-studio";
import { Fragment, useMemo } from "react";
import { WORDS } from "../i18n";
import { lineParts, lineSentence } from "../receipt-panel";
import { useWidget } from "./useWidget";

// "The book", and when the assistant narrowed it, a chip saying so that puts every line back (ASK-B2). A line pressed
// on the receipt's photo: beside the open book (S5) a plaque says who paid what of it, each payer a chip, over every
// row of the book; where the photo is over the book (phone, narrow window) a chip names the line the book is narrowed to.

export function BookHeadWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const w = WORDS[snap.lang];
  const line = snap.selected?.kind === "line" ? snap.selected : null;
  const said = useMemo(() => {
    if (!line) return null;
    const parts = lineParts(snap.view, snap.model, line.lineKey, snap.lang);
    return parts ? { parts, sentence: lineSentence(snap.view, snap.model, line.lineKey, snap.lang) ?? parts.head } : null;
  }, [line, snap.view, snap.model, snap.lang]);
  const clear = line ? () => store.toggle(line) : undefined;

  return (
    <div className="lg-book-head" ref={root}>
      <h2>{w.theBook}</h2>
      {snap.focus ? (
        <span className="lg-chip" data-label title={w.narrowed(snap.focus.label)}>
          <span className="lg-chip-label">{w.narrowed(snap.focus.label)}</span>
          <button type="button" aria-label={w.showAll} onClick={store.clearFocus}>
            ×
          </button>
        </span>
      ) : said && !snap.linesNarrow ? (
        <p className="lg-line-plaque" data-testid="line-sentence" title={said.sentence}>
          <b>{said.parts.payers.length ? `${said.parts.head} =` : said.parts.head}</b>
          {said.parts.payers.map((p, i) => (
            <Fragment key={`${p.label}-${i}`}>
              {i > 0 && <span aria-hidden="true">+</span>}
              <span className="lg-payer-chip" data-payer={p.label}>
                {p.label}
              </span>
              <span className="lg-plaque-amount">{p.amount}</span>
            </Fragment>
          ))}
          {said.parts.reason && <span className="lg-plaque-reason">— {said.parts.reason}</span>}
          <button type="button" aria-label={w.showAll} onClick={clear}>
            ×
          </button>
        </p>
      ) : (
        said && (
          <span className="lg-chip lg-chip-line" data-label data-testid="line-chip" title={said.sentence}>
            <span className="lg-chip-label">{said.parts.head}</span>
            <button type="button" aria-label={w.showAll} onClick={clear}>
              ×
            </button>
          </span>
        )
      )}
    </div>
  );
}
