"use client";

import { useEffect } from "react";
import { settled } from "../api";
import { DesktopHeader } from "../Header";
import { DesktopStage, useStacked } from "../stage";
import type { DriveView } from "../types";
import { LedgerStudio } from "./LedgerStudio";

interface Props {
  view: DriveView;
  following: boolean;
  refresh: () => Promise<unknown>;
  follow: () => void;
}

/** The Ledger tab: the same header as every screen, the report under it. Loaded only when opened. */
export function LedgerView({ view, following, refresh, follow }: Props) {
  const stacked = useStacked();
  // A drive that is closing or waiting for PayPal is watched as on every other screen.
  const moving = !settled(view);
  useEffect(() => {
    if (moving) follow();
  }, [moving, follow]);
  return (
    <>
      <DesktopStage>
        <DesktopHeader driveId={view.drive.id} title={view.drive.displayTitle} demo={view.drive.demo} role="ledger" variant="d" />
      </DesktopStage>
      <LedgerStudio view={view} stacked={stacked} stale={moving && !following} refresh={refresh} />
    </>
  );
}
