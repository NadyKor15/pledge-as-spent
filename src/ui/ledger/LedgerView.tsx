"use client";

import { useEffect } from "react";
import type { ModelPlan } from "@/agent/model-plan";
import { settled } from "../api";
import { useStacked } from "../stage";
import type { DriveView } from "../types";
import { LedgerStudio } from "./LedgerStudio";

interface Props {
  view: DriveView;
  following: boolean;
  refresh: () => Promise<unknown>;
  follow: () => void;
  /** The model the chat names before its first answer: the server's setting (src/app/drive/[id]/page.tsx). */
  modelPlan?: ModelPlan;
}

/** The Ledger tab's report. Loaded only when opened: the header stays above it meanwhile (DriveScreen). */
export function LedgerView({ view, following, refresh, follow, modelPlan }: Props) {
  const stacked = useStacked();
  // A drive that is closing or waiting for PayPal is watched as on every other screen.
  const moving = !settled(view);
  useEffect(() => {
    if (moving) follow();
  }, [moving, follow]);
  return <LedgerStudio view={view} stacked={stacked} stale={moving && !following} refresh={refresh} modelPlan={modelPlan} />;
}
