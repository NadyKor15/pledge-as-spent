"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LedgerContext } from "../store";

/**
 * What every custom widget of the report needs: the shared store, and Studio told the widget is
 * ready. Studio's keyboard model (a stop per widget, Enter to go inside) is switched off for these
 * in ledger.css: their buttons are ordinary buttons in the page's Tab order.
 */
export function useWidget<T extends HTMLElement>(params: AgWidgetParams) {
  const { store } = params.context as LedgerContext;
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const root = useRef<T>(null);
  const { widgetApi } = params;

  useEffect(() => {
    widgetApi.setDisplayState("displayed");
  }, [widgetApi]);

  return { store, snap, root };
}
