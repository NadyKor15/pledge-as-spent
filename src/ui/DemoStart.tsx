"use client";

import { useRouter } from "next/navigation";
import { api, useAction } from "./api";
import type { DriveView } from "./types";

/** Opens a fresh demo drive (four sandbox holds at PayPal) and goes to the coordinator's screen. */
export function DemoStart() {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const open = () =>
    run("open", async () => {
      const view = await api<DriveView>("/api/demo/drives", { method: "POST" });
      router.push(`/drive/${encodeURIComponent(view.drive.id)}?as=coordinator`);
    });
  return (
    <>
      <button type="button" className="ld-open" disabled={busy !== null} onClick={open}>
        {busy ? "Placing four holds at PayPal: three donors and the company match…" : "Open the demo drive"}
      </button>
      {error && (
        <p className="ld-error" role="alert">
          {error.error.message}
        </p>
      )}
    </>
  );
}
