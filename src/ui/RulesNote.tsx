"use client";

import type { CSSProperties } from "react";
import { money } from "./format";
import type { Statement } from "./types";

// The donor's rules for the lines their hold pays (DONOR_RULES), on their statement:
// what they set, and each line their rules kept the hold out of, with its price per
// unit. Embedded by the integrator next to RebindOffer; same tokens as the statement.

const card: CSSProperties = { margin: "9.6px 10px 0", padding: "10px 12px 11px", background: "var(--surface)", border: "1px solid var(--card-line)", borderRadius: "var(--r-card)" };
const h2: CSSProperties = { fontSize: 14, lineHeight: "20px", fontWeight: 700, letterSpacing: "-.55px" };
const p: CSSProperties = { marginTop: 4, fontSize: 12.2, lineHeight: "16.5px", letterSpacing: "-.3px", color: "var(--slate)" };

export function RulesNote({ statement, labelOf }: { statement: Statement; labelOf?: (needId: string) => string | undefined }) {
  const rules = statement.balance.rules;
  if (!rules) return null;
  const label = (id: string) => labelOf?.(id) ?? id;
  const cur = statement.currency;
  const parts = [
    ...(rules.needs ? [`only ${rules.needs.map(label).join(", ")}`] : []),
    ...(rules.maxUnitMinor !== undefined ? [`at most ${money(cur, rules.maxUnitMinor)} per unit, its share of tax included`] : []),
  ];
  const out = statement.ruledOut ?? [];
  return (
    <section style={card} aria-label="Your rules for the lines your hold pays" data-testid="rules-note">
      <h2 style={h2}>Your rules</h2>
      <p style={p}>Your hold pays {parts.join("; ")}. A line outside them is paid by the other donors, or not at all, never by you.</p>
      {out.map((r) => (
        <p key={`${r.receiptId}:${r.lineNo}`} style={{ ...p, color: "var(--ink)" }} data-testid="rules-out">
          {r.reason === "price"
            ? `${label(r.needId)}, ${r.qty} at ${money(cur, r.unitQuote)} each: above your ${money(cur, rules.maxUnitMinor ?? 0)}, so your hold did not pay it.`
            : `${label(r.needId)}: not among your needs, so your hold did not pay it.`}
          {r.funded ? "" : ` No hold of ${label(r.needId)} could pay it, so the line was refused and ${label(r.needId)} is still open.`}
        </p>
      ))}
    </section>
  );
}
