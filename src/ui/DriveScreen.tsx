"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { use } from "react";
import type { ModelPlan } from "@/agent/model-plan";
import { useDrive } from "./api";
import { CoordinatorView } from "./CoordinatorView";
import { DonorView } from "./DonorView";
import { DesktopHeader } from "./Header";
import { VolunteerView } from "./VolunteerView";
import { DesktopStage } from "./stage";
import { DriveLoading, Failure, Skeleton, StaleData } from "./states";
import { isRole } from "./types";

// AG Studio is by far the heaviest thing in the app, and only this tab needs it.
const LedgerView = dynamic(() => import("./ledger/LedgerView").then((m) => m.LedgerView), { ssr: false, loading: () => <Skeleton /> });

/** One drive, seen by the role in `?as=` (donor when absent). `modelPlan` is the server's agent setting, for the Ledger's chat. */
export function DriveScreen({ params, modelPlan }: { params: Promise<{ id: string }>; modelPlan?: ModelPlan }) {
  const { id } = use(params);
  const as = useSearchParams().get("as");
  const role = isRole(as) ? as : "donor";
  const d = useDrive(id);

  if (!d.view) {
    if (!d.error) return <DriveLoading />;
    return <Failure title={d.error.status === 404 ? "No such drive" : "The drive could not be loaded"} message={d.error.message} />;
  }
  const stale = <StaleData error={d.error} retry={d.refresh} />;
  if (role === "ledger" || role === "volunteer") {
    return (
      <>
        {stale}
        <DesktopStage>
          <DesktopHeader driveId={id} title={d.view.drive.displayTitle} demo={d.view.drive.demo} role={role} variant="d" />
        </DesktopStage>
        {role === "ledger" ? <LedgerView view={d.view} following={d.following} refresh={d.refresh} follow={d.follow} modelPlan={modelPlan} /> : <VolunteerView view={d.view} following={d.following} refresh={d.refresh} follow={d.follow} />}
      </>
    );
  }
  return (
    <>
      {stale}
      <DesktopStage>
        {role === "coordinator" ? (
          <CoordinatorView view={d.view} following={d.following} refresh={d.refresh} follow={d.follow} />
        ) : (
          <DonorView view={d.view} role={role} />
        )}
      </DesktopStage>
    </>
  );
}
