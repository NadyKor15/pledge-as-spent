"use client";

import { useState, type CSSProperties } from "react";
import { api, useAction } from "./api";
import { day, money, qtyText } from "./format";
import type { StatementView } from "./types";

// "Move what is left to another need": one press on the donor's statement.
// Sits inside the statement page (.st-page), so it uses the page's colour tokens.
// The server decides; this only shows what /api/pledges/:id/statement offers.

const card: CSSProperties = { margin: "9.6px 10px 0", padding: "10px 12px 11px", background: "var(--surface)", border: "1px solid var(--card-line)", borderRadius: "var(--r-card)" };
const h2: CSSProperties = { fontSize: 14, lineHeight: "20px", fontWeight: 700, letterSpacing: "-.55px" };
const p: CSSProperties = { marginTop: 4, fontSize: 12.2, lineHeight: "16.5px", letterSpacing: "-.3px", color: "var(--slate)" };
const choice: CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 7, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: "var(--r-chip)", fontSize: 12.6, cursor: "pointer" };
const btn: CSSProperties = { display: "block", marginTop: 10, width: "100%", height: 34.3, border: 0, borderRadius: "var(--r-btn)", background: "var(--btn)", color: "var(--surface)", fontSize: 12.6, fontWeight: 600, cursor: "pointer" };
const quiet: CSSProperties = { ...btn, background: "transparent", color: "var(--teal-ink)", border: "1px solid var(--card-line)", marginTop: 6 };

export interface RebindOfferProps {
  pledgeId: string;
  /** null while the feature is off: nothing is shown. */
  offer: StatementView["rebind"];
  /** Screen names of the needs (the demo's display labels); falls back to the book's label. */
  labelOf?: (needId: string) => string | undefined;
  /** Called after a move, so the page re-reads the statement. */
  onMoved?: () => void;
}

export function RebindOffer(props: RebindOfferProps) {
  const { offer, labelOf } = props;
  if (!offer) return null;
  const label = (id: string | null) => (id ? (labelOf?.(id) ?? id) : "");
  return (
    <>
      <KeptRest offer={offer} label={label} />
      <MoveOffer {...props} />
    </>
  );
}

/** The donor's choice at the pledge, "keep the rest for next purchases", and where the rest went because of it. */
function KeptRest({ offer, label }: { offer: NonNullable<StatementView["rebind"]>; label: (id: string | null) => string }) {
  const carried = offer.carried ?? [];
  if (offer.rest !== "carry" && carried.length === 0) return null;
  return (
    <section style={card} aria-label="What happens to the rest" data-testid="rest-kept">
      <h2 style={h2}>You kept the rest for next purchases</h2>
      <p style={p}>
        When {label(offer.needId)} is covered, what your hold has not paid for moves by itself to the open need furthest from covered (not in the hold&apos;s last 3 days). It is the same PayPal hold: moving it charges nothing, and what no purchase uses is never charged: PayPal releases it.
      </p>
      {carried.map((c) => (
        <p key={`${c.fromNeedId}>${c.toNeedId}`} style={{ ...p, color: "var(--ink)" }} data-testid="rest-carried">
          {day(c.at)}: {label(c.fromNeedId)} was covered, the rest moved to {label(c.toNeedId)}.
        </p>
      ))}
    </section>
  );
}

function MoveOffer({ pledgeId, offer: given, labelOf, onMoved }: RebindOfferProps) {
  const [pick, setPick] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  if (!given) return null;
  const offer = given;
  const label = (id: string | null, fallback?: string) => (id ? (labelOf?.(id) ?? fallback ?? id) : "");

  if (offer.rebound) {
    const r = offer.rebound;
    return (
      <section style={card} aria-label="Your pledge moved" data-testid="rebind-done">
        <h2 style={h2}>You moved what was left</h2>
        <p style={p}>
          On {day(r.at)} you moved the rest of your pledge from {label(r.fromNeedId)} to {label(r.toNeedId)}. It is the same PayPal hold: nothing was charged when you moved it, and only purchases of {label(r.toNeedId)} can use it now.
        </p>
      </section>
    );
  }
  if (offer.targets.length === 0 || offer.available.minor <= 0) return null;

  const target = offer.targets.find((t) => t.needId === pick) ?? null;
  const left = money(offer.available.currency, offer.available.minor);
  const move = () =>
    action.run("rebind", async () => {
      await api(`/api/pledges/${encodeURIComponent(pledgeId)}/rebind`, { json: { from: offer.needId, to: target!.needId } });
      setConfirming(false);
      onMoved?.();
    });

  return (
    <section style={card} aria-label="Move what is left to another need" data-testid="rebind-offer">
      <h2 style={h2}>Move the {left} left to another need?</h2>
      <p style={p}>
        Your hold backs {label(offer.needId)}. You can move what it has not paid for yet to one need that is still open. Once, before the drive closes.
      </p>
      <div role="radiogroup" aria-label="Open needs">
        {offer.targets.map((t) => (
          <label key={t.needId} style={{ ...choice, borderColor: pick === t.needId ? "var(--btn)" : "var(--line)" }}>
            <input type="radio" name={`rebind-${pledgeId}`} value={t.needId} checked={pick === t.needId} onChange={() => { setPick(t.needId); setConfirming(false); }} />
            <span>
              {label(t.needId, t.label)} <span style={{ color: "var(--slate)" }}>· still needs {qtyText(t.remainingQty, t.unit)}</span>
            </span>
          </label>
        ))}
      </div>
      {!confirming ? (
        <button type="button" style={{ ...btn, opacity: target ? 1 : 0.5 }} disabled={!target} onClick={() => setConfirming(true)} data-testid="rebind-choose">
          {target ? `Move it to ${label(target.needId, target.label)}` : "Pick a need"}
        </button>
      ) : (
        <>
          <p style={{ ...p, color: "var(--ink)" }} data-testid="rebind-confirm-text">
            Same PayPal hold, same amount, same expiry{offer.expiresAt ? ` (${day(offer.expiresAt)})` : ""}. Nothing is charged now. {label(offer.needId)} gets nothing more from it; {label(target!.needId, target!.label)} can use up to {left}, only for what it still lacks. Whatever is not spent is never charged and goes back to you at the close.
          </p>
          <button type="button" style={btn} disabled={action.busy === "rebind"} onClick={move} data-testid="rebind-confirm">
            {action.busy === "rebind" ? "Moving…" : `Yes, move ${left}`}
          </button>
          <button type="button" style={quiet} onClick={() => setConfirming(false)}>
            Keep it on {label(offer.needId)}
          </button>
        </>
      )}
      {action.error && (
        <p style={{ ...p, color: "var(--no)" }} role="alert">
          {action.error.error.message}
        </p>
      )}
    </section>
  );
}
