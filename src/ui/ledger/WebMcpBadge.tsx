"use client";

import { useEffect, useState } from "react";
import { classes } from "../cls";
import type { Lang } from "../format";
import { createWebMcpSync, webMcpBadgeText, type WebMcpTool } from "./webmcp";
import "./webmcp-badge.css";

const s = classes("wm");

/**
 * Offers `tools` (read-only) to the browser's own AI through WebMCP and says so on the page, or says the
 * browser has no WebMCP. Nothing is shown until the browser has been asked, so the server's HTML claims neither.
 */
export function WebMcpBadge({ tools, lang = "en" }: { tools: readonly WebMcpTool[]; lang?: Lang }) {
  const [state, setState] = useState<{ supported: boolean; count: number } | null>(null);
  useEffect(() => {
    let live = true;
    const sync = createWebMcpSync(() => tools);
    void sync.sync().then((r) => {
      if (live) setState({ supported: r.supported, count: r.registered.length });
    });
    return () => {
      live = false;
      sync.destroy();
    };
  }, [tools]);
  if (!state) return null;
  return (
    <p className={`${s.badge} ${state.supported ? s.on : s.off}`} role="status" data-testid="webmcp-badge" data-webmcp={state.supported ? "on" : "off"}>
      {webMcpBadgeText(state.supported, state.count, lang)}
    </p>
  );
}
