import type { Metadata } from "next";
import { Suspense } from "react";
import { DriveScreen } from "@/ui/DriveScreen";
import { Loading } from "@/ui/states";

export const metadata: Metadata = { title: "Drive — Pledge-as-Spent" };

export default function DrivePage({ params }: PageProps<"/drive/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <DriveScreen params={params} />
    </Suspense>
  );
}
