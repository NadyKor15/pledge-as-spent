"use client";
import type { DriveView, Role } from "./types";
export function DonorView({ view, role }: { view: DriveView; role: Role }) {
  return <p>{role} {view.drive.id}</p>;
}
