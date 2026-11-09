import type { Metadata } from "next";
import { FORGERIES } from "@/server/cheat";
import { CheatLab } from "@/ui/cheat/CheatLab";

export const metadata: Metadata = { title: "Try to cheat the receipt — Pledge-as-Spent" };

/** Five forged receipts against a copy of the demo drive: the checks run on the server when one is picked. */
export default function CheatPage() {
  return <CheatLab forgeries={FORGERIES} />;
}
