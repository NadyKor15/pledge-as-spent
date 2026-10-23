"use client";
import type { DriveView } from "./types";
export function VolunteerView({ view }: { view: DriveView; refresh: () => Promise<unknown>; follow: () => void }) {
  return <p>volunteer {view.drive.id}</p>;
}
