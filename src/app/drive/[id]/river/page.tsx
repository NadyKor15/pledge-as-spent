import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { riverOn } from "@/ui/river/flag";
import { RiverScreen } from "@/ui/river/RiverScreen";
import { Loading } from "@/ui/states";

export const metadata: Metadata = { title: "River of money — Pledge-as-Spent" };

export default function DriveRiverPage({ params }: PageProps<"/drive/[id]/river">) {
  // П2 exists only where the deployment switched it on (NEXT_PUBLIC_RIVER=on, read when the app is built).
  if (!riverOn(process.env.NEXT_PUBLIC_RIVER)) notFound();
  return (
    <Suspense fallback={<Loading what="the river of money" />}>
      <RiverScreen params={params} />
    </Suspense>
  );
}
