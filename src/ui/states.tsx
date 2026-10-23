import Link from "next/link";
import "./screen.css";
import { classes } from "./cls";

const s = classes("sc");

export function Loading({ what = "the drive" }: { what?: string }) {
  return (
    <div className={s.state} role="status">
      Loading {what}…
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
