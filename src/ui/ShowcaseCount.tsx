"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The landing page's count of the finished drive, added up on the server by the Ledger's own derive
 * (/api/showcase/count). No such drive, or no answer: no line, rather than a number nobody checked.
 */
export function ShowcaseCount() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ line: string | null }>("/api/showcase/count").then(
      (r) => {
        if (live) setLine(r.line);
      },
      () => {
        if (live) setLine(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (!line) return null;
  return (
    <p className="ld-count" data-testid="landing-count">
      {line}
    </p>
  );
}
