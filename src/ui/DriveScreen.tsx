"use client";

import { useSearchParams } from "next/navigation";
import { use } from "react";
import { useDrive } from "./api";
import { CoordinatorView } from "./CoordinatorView";
import { DonorView } from "./DonorView";
import { DesktopHeader } from "./Header";
import { VolunteerView } from "./VolunteerView";
import { DesktopStage } from "./stage";
import { Failure, Loading } from "./states";
import { isRole } from "./types";

/** One drive, seen by the role in `?as=` (donor when absent). */
export function DriveScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const as = useSearchParams().get("as");
  const role = isRole(as) ? as : "donor";
  const d = useDrive(id);

  if (!d.view) {
    if (!d.error) return <Loading />;
    return <Failure title={d.error.status === 404 ? "No such drive" : "The drive could not be loaded"} message={d.error.message} />;
  }
  if (role === "volunteer") {
    return (
      <>
        <DesktopStage>
          <DesktopHeader driveId={id} title={d.view.drive.displayTitle} demo={d.view.drive.demo} role="volunteer" variant="d" />
        </DesktopStage>
        <VolunteerView view={d.view} refresh={d.refresh} follow={d.follow} />
      </>
    );
  }
  return (
    <DesktopStage>
      {role === "coordinator" ? (
        <CoordinatorView view={d.view} following={d.following} refresh={d.refresh} follow={d.follow} />
      ) : (
        <DonorView view={d.view} role={role} />
      )}
    </DesktopStage>
  );
}
