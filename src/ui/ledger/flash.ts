import type { LedgerBookRow } from "./derive";

// The book is re-read every few seconds while PayPal works. A row whose money just moved flashes once: green when
// PayPal took it, blue when it came back. Studio 3.0.0 rebuilds a row whose values change (its row id is made of
// them), so its own cell-change flash never fires; this compares the book itself, by each row's ledger id.

export type FlashKind = "spent" | "back";

/** How long a flash lasts; the CSS animation in ledger.css runs as long. */
export const FLASH_MS = 2400;

const KIND: Record<string, FlashKind> = { captured: "spent", reversed: "back", partly_reversed: "back", uncollected: "back" };

/** The rows of `after` whose status or capture differ from `before`, with the colour of what happened to them. */
export function bookChanges(before: readonly LedgerBookRow[], after: readonly LedgerBookRow[]): Map<string, FlashKind> {
  const old = new Map(before.map((r) => [r.rowKey, r]));
  const out = new Map<string, FlashKind>();
  for (const r of after) {
    const o = old.get(r.rowKey);
    if (!o || (o.code === r.code && o.capture === r.capture)) continue;
    const kind = KIND[r.code];
    if (kind) out.set(r.rowKey, kind);
  }
  return out;
}
