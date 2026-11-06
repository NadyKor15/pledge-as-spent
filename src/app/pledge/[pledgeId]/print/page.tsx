import type { Metadata } from "next";
import { Suspense } from "react";
import { StatementPrintScreen } from "@/ui/statement/StatementPrint";
import { Loading } from "@/ui/states";

export const metadata: Metadata = { title: "Donor statement — Pledge-as-Spent" };

export default function PledgePrintPage({ params }: PageProps<"/pledge/[pledgeId]/print">) {
  return (
    <Suspense fallback={<Loading what="your statement" />}>
      <StatementPrintScreen params={params} />
    </Suspense>
  );
}
