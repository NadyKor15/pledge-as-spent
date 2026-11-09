"use client";

import { useRouter } from "next/navigation";
import { api, useAction } from "./api";
import type { DriveView } from "./types";

/**
 * Opens a fresh demo drive (sandbox holds at PayPal) and goes to the coordinator's screen. Without `scenario` it is the
 * Kitasora drive; with one, the server's scenario of that id (`{ scenario }` in the request body).
 */
export function DemoStart({ scenario, label = "Open the demo drive", busyLabel = "Placing four holds at PayPal: three donors and the company match…", secondary = false }: { scenario?: string; label?: string; busyLabel?: string; secondary?: boolean } = {}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const open = () =>
    run("open", async () => {
      const view = await api<DriveView>("/api/demo/drives", scenario ? { method: "POST", json: { scenario } } : { method: "POST" });
      router.push(`/drive/${encodeURIComponent(view.drive.id)}?as=coordinator`);
    });
  return (
    <>
      <button type="button" className={secondary ? "ld-open ld-open-2" : "ld-open"} disabled={busy !== null} onClick={open} data-scenario={scenario ?? "kitasora"}>
        {busy ? busyLabel : label}
      </button>
      {error && (
        <p className="ld-error" role="alert">
          {error.error.message}
        </p>
      )}
    </>
  );
}
