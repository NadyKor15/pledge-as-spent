"use client";

import type { AgWidgetParams } from "ag-studio";
import type { LedgerModel } from "../derive";
import { NOTE_REST } from "../studio-state";
import { useWidget } from "./useWidget";

// One line under a total. It reads the store, not the report: a re-read of the drive changes it in place.

const textOf = (m: LedgerModel, id: string) => (id === NOTE_REST ? m.restNote : m.waitingNote);

export function NoteWidget(params: AgWidgetParams) {
  const { snap, root } = useWidget<HTMLDivElement>(params);
  const text = textOf(snap.model, params.widgetId);
  return (
    <div className={`lg-note${params.widgetId === NOTE_REST ? " lg-note-rest" : ""}`} ref={root}>
      {text && <p data-label>{text}</p>}
    </div>
  );
}
