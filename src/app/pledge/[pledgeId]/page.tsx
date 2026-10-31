import type { Metadata } from "next";
import { Suspense } from "react";
import { StatementScreen } from "@/ui/StatementView";
import { Loading } from "@/ui/states";

export const metadata: Metadata = { title: "Your pledge — Pledge-as-Spent" };

export default function PledgePage({ params }: PageProps<"/pledge/[pledgeId]">) {
  return (
    <Suspense fallback={<Loading what="your statement" />}>
      <StatementScreen params={params} />
    </Suspense>
  );
}
