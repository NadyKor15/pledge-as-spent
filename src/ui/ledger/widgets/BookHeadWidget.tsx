"use client";

import type { AgWidgetParams } from "ag-studio";
import { useMemo } from "react";
import { WORDS } from "../i18n";
import { lineSentence, receiptPanel } from "../receipt-panel";
import { useWidget } from "./useWidget";

// "The book", and when the assistant narrowed it, a chip saying so that puts every line back (ASK-B2). A line pressed
// on the receipt's photo gets the same chip with the proof band's sentence: who paid what of it.

export function BookHeadWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const w = WORDS[snap.lang];
  const line = snap.selected?.kind === "line" ? snap.selected : null;
  const said = useMemo(() => {
    if (!line) return null;
    const sentence = lineSentence(snap.view, snap.model, line.lineKey, snap.lang);
    const mark = receiptPanel(snap.view, snap.model, snap.lang);
    const short = [...(mark?.placed ?? []), ...(mark?.unplaced ?? [])].find((x) => x.lineKey === line.lineKey)?.label ?? sentence;
    return sentence ? { sentence, short: short ?? sentence } : null;
  }, [line, snap.view, snap.model, snap.lang]);
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
      ) : (
        line &&
        said && (
          <span className="lg-chip lg-chip-line" data-label data-testid="line-sentence" title={said.sentence}>
            <span className="lg-chip-label">
              <span className="lg-chip-long">{said.sentence}</span>
              <span className="lg-chip-short" aria-hidden="true">
                {said.short}
              </span>
            </span>
            <button type="button" aria-label={w.showAll} onClick={() => store.toggle(line)}>
              ×
            </button>
          </span>
        )
      )}
    </div>
  );
}
