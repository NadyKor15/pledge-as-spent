"use client";

import { useMemo, useSyncExternalStore } from "react";
import { shownHolds } from "@/ui/derive";
import { donorParts } from "@/ui/format";
import type { AskComponent, LedgerStore } from "@/ui/ledger/store";
import { studioReadOnlyTools, type WebMcpTool } from "@/ui/ledger/webmcp";
import { WebMcpBadge } from "@/ui/ledger/WebMcpBadge";
import type { DriveView } from "@/ui/types";
import type { LedgerAgent } from "../harness";
import { ledgerToolSpecs } from "../tools";
import { AskWidget } from "./AskWidget";

// The chat in the book's `ledger-ask` slot: the agent of the page, the book's language and narrowing,
// and the WebMCP line beside the model's name. The slot's widget is memoised by React Compiler on its
// props, so everything that changes is read through useSyncExternalStore.

/** The book's tools for the browser's own AI (WebMCP), read-only, the same answers the agent gets. */
export function ledgerWebMcpTools(getView: () => DriveView): WebMcpTool[] {
  return ledgerToolSpecs(getView).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    readOnly: true as const,
    execute: (args: Record<string, unknown>) => t.execute(args).text,
  }));
}

/** The component the book's store renders in its slot, bound to this page's agent. */
export function askComponentFor(agent: LedgerAgent): AskComponent {
  function BookAsk({ store }: { store: LedgerStore }) {
    const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
    const studio = useSyncExternalStore(agent.subscribe, () => agent.get().studio, () => 0);
    const view = snap.view;
    const donors = useMemo(
      () =>
        (view ? shownHolds(view) : [])
          .filter((h) => h.kind === "donor")
          .map((h) => {
            const { name, place } = donorParts(h.donorName);
            return { name: h.donorName, label: place ? `${name} · ${place}` : name };
          }),
      [view],
    );
    // Studio's own read-only tools belong to the Studio of the moment: read again whenever another is attached.
    const tools = useMemo(() => {
      const api = studio > 0 ? agent.studioApi() : null;
      const book = ledgerWebMcpTools(() => store.get().view!);
      try {
        return api ? [...book, ...studioReadOnlyTools(api)] : book;
      } catch {
        return book;
      }
    }, [studio, store]);
    return <AskWidget agent={agent} locale={snap.lang} donors={donors} onFocusLines={store.focusLines} footExtra={<WebMcpBadge tools={tools} lang={snap.lang} />} />;
  }
  return BookAsk;
}
