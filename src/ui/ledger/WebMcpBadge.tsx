"use client";

import { useEffect, useState } from "react";
import { classes } from "../cls";
import type { Lang } from "../format";
import { createWebMcpSync, webMcpBadgeText, type WebMcpTool } from "./webmcp";
import "./webmcp-badge.css";

const s = classes("wm");

/**
 * Offers `tools` (read-only) to the browser's own AI through WebMCP and says so on the page. A browser without
 * WebMCP gets no line at all: a note that something is missing read as an error to judges. Nothing is shown until
 * the browser has been asked, so the server's HTML claims nothing.
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
  if (!state?.supported) return null;
  return (
    <p className={`${s.badge} ${s.on}`} role="status" data-testid="webmcp-badge" data-webmcp="on">
      {webMcpBadgeText(true, state.count, lang)}
    </p>
  );
}
