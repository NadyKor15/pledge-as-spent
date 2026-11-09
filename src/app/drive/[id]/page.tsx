import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { agentModelPlan } from "@/server/agent-env";
import { DriveScreen } from "@/ui/DriveScreen";
import { DriveLoading } from "@/ui/states";

export const metadata: Metadata = { title: "Drive — Pledge-as-Spent" };

/** The screen with the server's agent setting, read when the page is asked for, not when it was built. */
async function Screen({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  // A word ("meta" or "off") for the chat's small print: the Meta key itself never leaves the server.
  return <DriveScreen params={params} modelPlan={agentModelPlan(process.env)} />;
}

export default function DrivePage({ params }: PageProps<"/drive/[id]">) {
  return (
    <Suspense fallback={<DriveLoading />}>
      <Screen params={params} />
    </Suspense>
  );
}
