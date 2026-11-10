"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect } from "react";
import { useWidget } from "./useWidget";

// The slot over the book for the assistant's chat. The chat itself belongs to the assistant's lane: it hands its
// component to the store (store.setAskComponent) and it is rendered here, inside Studio's layout and theme.
// Without a component the layout leaves this widget out and takes no height for it (LedgerStudio, metrics).

/** While a question is on its way the chat is not measured: a new layout then would cut the agent's turn short. */
const BUSY = new Set(["asking", "thinking"]);

export function AskSlotWidget(params: AgWidgetParams) {
  const { store, snap, root } = useWidget<HTMLDivElement>(params);
  const Ask = snap.askComponent;

  // Stacked, the chat has a slot of fixed height: an answer or a failure note taller than it was cut, its heading
  // scrolled away at the top and "Ask again" at the bottom. Once the chat settles, the slot is asked to grow to it.
  useEffect(() => {
    const slot = root.current;
    if (!Ask || !slot) return;
    const measure = () => {
      // Read each time: Studio may build the widget before it puts it in the page.
      if (!slot.closest('[data-stacked="true"]')) return;
      const chat = slot.querySelector<HTMLElement>('[data-testid="ask-widget"]');
      if (!chat || BUSY.has(chat.dataset.phase ?? "")) return;
      // The chat's own bottom border is outside its scroll height.
      if (chat.scrollHeight > chat.clientHeight + 1) store.setAskPx(chat.scrollHeight + 2);
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(slot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-phase"] });
    void document.fonts?.ready.then(measure);
    return () => mo.disconnect();
  }, [Ask, root, store]);

  return (
    <div className="lg-ask-slot" ref={root}>
      {Ask && <Ask store={store} />}
    </div>
  );
}
