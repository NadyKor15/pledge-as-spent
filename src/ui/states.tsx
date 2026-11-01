import Link from "next/link";
import "./screen.css";
import { classes } from "./cls";
import type { ApiError } from "./api";

const s = classes("sc");

export function Loading({ what = "the dashboard" }: { what?: string }) {
  return (
    <div className={s.state} role="status">
      Loading {what}…
    </div>
  );
}

/** The screen's shape while its data or its code is on the way. */
export function Skeleton() {
  return (
    <div className={s.skeleton} role="status">
      <p>Loading the dashboard…</p>
      <div className={s.skRow} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className={s.skBody} aria-hidden="true">
        <i />
        <i />
      </div>
    </div>
  );
}

/** The first paint of a drive: nothing is known about it yet but the product's name. */
export function DriveLoading() {
  return (
    <>
      <div className={s.skHead}>
        <Link href="/">Pledge-as-Spent</Link>
      </div>
      <Skeleton />
    </>
  );
}

/** A re-read failed: the figures on the screen are the last ones that came through. */
export function StaleData({ error, retry }: { error: ApiError | null; retry: () => Promise<unknown> }) {
  if (!error) return null;
  return (
    <div className={s.stale} role="alert">
      Can’t reach the server, showing the last data
      <button type="button" onClick={() => void retry()}>
        Try again
      </button>
    </div>
  );
}

export function Failure({ title, message }: { title: string; message: string }) {
  return (
    <div className={s.state} role="alert">
      <h1>{title}</h1>
      <p>{message}</p>
      <Link href="/">Open a new demo drive</Link>
    </div>
  );
}
