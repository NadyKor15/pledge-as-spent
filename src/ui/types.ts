import type { DriveView, PledgeService } from "@/server/service";

// Shapes of the JSON the API returns (type-only: nothing from the server is bundled).

export type { DriveView };
export type Hold = DriveView["holds"][number];
export type Need = DriveView["needs"][number];
export type Receipt = DriveView["receipts"][number];
export type ReceiptLine = Receipt["lines"][number];
export type LedgerRow = DriveView["ledger"][number];
export type JournalCall = DriveView["paypal"][number];
export type StatementView = Awaited<ReturnType<PledgeService["getStatement"]>>;
export type Statement = StatementView["statement"];

export type Role = "shelter" | "donor" | "volunteer" | "coordinator" | "ledger";
export const ROLES: { id: Role; label: string }[] = [
  { id: "shelter", label: "Shelter" },
  { id: "donor", label: "Donor" },
  { id: "volunteer", label: "Volunteer" },
  { id: "coordinator", label: "Coordinator" },
  { id: "ledger", label: "Ledger" },
];
export const isRole = (v: unknown): v is Role => ROLES.some((r) => r.id === v);
