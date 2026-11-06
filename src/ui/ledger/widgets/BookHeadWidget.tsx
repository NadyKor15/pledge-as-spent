"use client";

import type { AgWidgetParams } from "ag-studio";
import { WORDS } from "../i18n";
import { useWidget } from "./useWidget";

// "The book", and when the assistant narrowed it, a chip saying so that puts every line back (ASK-B2).

export function BookHeadWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const w = WORDS[snap.lang];
  return (
    <div className="lg-book-head" ref={root}>
      <h2>{w.theBook}</h2>
      {snap.focus && (
        <span className="lg-chip" data-label>
          {w.narrowed(snap.focus.label)}
          <button type="button" aria-label={w.showAll} onClick={store.clearFocus}>
            ×
          </button>
        </span>
      )}
    </div>
  );
}
