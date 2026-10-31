import { notFound } from "next/navigation";
import type { ReactNode } from "react";

/** The debug pages are for local runs; a deployment shows them only with DEBUG_PAGES=on. */
export default function DebugLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production" && process.env.DEBUG_PAGES !== "on") notFound();
  return children;
}
