"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DriveView } from "./types";

// Browser side of the JSON API: every screen reads and writes through these
// routes only, so what it shows is exactly what the API returns.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(path, {
      cache: "no-store",
      ...rest,
      ...(json !== undefined ? { method: rest.method ?? "POST", body: JSON.stringify(json), headers: { "content-type": "application/json", ...rest.headers } } : {}),
    });
  } catch {
    throw new ApiError(0, "network", "The server could not be reached. Check your connection and try again.");
  }
  let body: { error?: string; message?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `http_${res.status}`, body?.message ?? `The request failed (HTTP ${res.status}).`);
  return body as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "unknown", errorText(e)));

/** Webhooks from the sandbox arrive 10–75 s after a capture or payout. */
const POLL_MS = 2500;
const POLL_FOR_MS = 60_000;

/** Nothing left that a webhook or lookup could still change. */
export function settled(v: DriveView): boolean {
  return v.drive.status !== "closing" && v.holds.every((h) => h.capturePending === 0) && v.payouts.every((p) => !p.attempts.some((a) => a.status === "pending"));
}

/**
 * The drive as the API has it. After an action, `follow()` re-reads it every
 * 2.5 s for up to a minute (or until nothing is pending); after that the
 * screen offers a Refresh button.
 */
export function useDrive(driveId: string) {
  const [view, setView] = useState<DriveView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [following, setFollowing] = useState(false);
  const until = useRef(0);

  const load = useCallback(() => api<DriveView>(`/api/drives/${encodeURIComponent(driveId)}`), [driveId]);

  const refresh = useCallback(async (): Promise<DriveView | null> => {
    try {
      const v = await load();
      setView(v);
      setError(null);
      return v;
    } catch (e) {
      setError(asApiError(e));
      return null;
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load().then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(null);
      },
      (e) => {
        if (live) setError(asApiError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  const follow = useCallback(() => {
    until.current = Date.now() + POLL_FOR_MS;
    setFollowing(true);
  }, []);

  useEffect(() => {
    if (!following) return;
    const t = setInterval(async () => {
      const v = await refresh();
      if (Date.now() >= until.current || (v && settled(v))) setFollowing(false);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [following, refresh]);

  return { view, error, refresh, follow, following, setView };
}

/** Runs one action at a time; its error stays on screen until the next one. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; error: ApiError } | null>(null);
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError({ name, error: asApiError(e) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
