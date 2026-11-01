"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LedgerContext } from "../store";

/**
 * What every custom widget of the report needs: the shared store, Studio told the widget is
 * ready, and a name on the stop Studio's keyboard model gives each widget (Tab between
 * widgets, Enter to go inside, Escape to come back out), which has none of its own.
 */
export function useWidget<T extends HTMLElement>(params: AgWidgetParams, name: string) {
  const { store } = params.context as LedgerContext;
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const root = useRef<T>(null);
  const { widgetApi } = params;

  useEffect(() => {
    widgetApi.setDisplayState("displayed");
    // Studio attaches this widget to its frame on its own schedule: wait for the frame to be there.
    let frame = 0;
    let tries = 0;
    const label = () => {
      const stop = root.current?.closest(".ag-studio-layout-widget")?.querySelector(".ag-studio-layout-widget-focus-container");
      if (stop) {
        stop.setAttribute("role", "group");
        stop.setAttribute("aria-label", `${name}. Press Enter to go inside.`);
      } else if (tries++ < 120) frame = requestAnimationFrame(label);
    };
    label();
    return () => cancelAnimationFrame(frame);
  }, [widgetApi, name]);

  return { store, snap, root };
}
