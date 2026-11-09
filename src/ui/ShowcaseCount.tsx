"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { countLine } from "./landing-count";
import { deriveLedger } from "./ledger/derive";
import { SHOWCASE_DRIVE_ID } from "./showcase";
import type { DriveView } from "./types";

/**
 * The landing page's count of the finished drive, read from the drive itself and added up by the Ledger's own derive.
 * The drive cannot be read (a fresh database, a deployment without it): no line, rather than a number nobody checked.
 */
export function ShowcaseCount() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<DriveView>(`/api/drives/${encodeURIComponent(SHOWCASE_DRIVE_ID)}`).then(
      (v) => {
        if (live) setLine(countLine(deriveLedger(v, "en")));
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
