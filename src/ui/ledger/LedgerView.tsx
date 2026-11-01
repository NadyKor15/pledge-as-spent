"use client";

import { DesktopHeader } from "../Header";
import { DesktopStage, useStacked } from "../stage";
import type { DriveView } from "../types";
import { LedgerStudio } from "./LedgerStudio";

/** The Ledger tab: the same header as every screen, the report under it. Loaded only when opened. */
export function LedgerView({ view }: { view: DriveView }) {
  const stacked = useStacked();
  return (
    <>
      <DesktopStage>
        <DesktopHeader driveId={view.drive.id} title={view.drive.displayTitle} demo={view.drive.demo} role="ledger" variant="d" />
      </DesktopStage>
      <LedgerStudio view={view} stacked={stacked} />
    </>
  );
}
