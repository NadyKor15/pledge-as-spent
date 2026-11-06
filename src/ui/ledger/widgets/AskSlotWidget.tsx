"use client";

import type { AgWidgetParams } from "ag-studio";
import { useWidget } from "./useWidget";

// The slot over the book for the assistant's chat. The chat itself belongs to the assistant's lane: it hands its
// component to the store (store.setAskComponent) and it is rendered here, inside Studio's layout and theme.
// Without a component the layout leaves this widget out and takes no height for it (LedgerStudio, metrics).

export function AskSlotWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const Ask = snap.askComponent;
  return (
    <div className="lg-ask-slot" ref={root}>
      {Ask && <Ask store={store} />}
    </div>
  );
}
