import type { Metadata } from "next";
import { Suspense } from "react";
import { PosterScreen } from "@/ui/poster/PosterScreen";
import { Loading } from "@/ui/states";

export const metadata: Metadata = { title: "Shelter poster — Pledge-as-Spent" };

export default function DrivePosterPage({ params }: PageProps<"/drive/[id]/poster">) {
  return (
    <Suspense fallback={<Loading what="the poster" />}>
      <PosterScreen params={params} />
    </Suspense>
  );
}
