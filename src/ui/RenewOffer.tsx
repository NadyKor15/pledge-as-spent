"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type CSSProperties } from "react";
import { api, errorText, useAction } from "./api";
import { day, money } from "./format";
import { pledgeScriptOptions } from "./pledge-paypal";
import type { StatementView } from "./types";

// The end of the hold and its renewal, on the donor's statement (RENEW_ENABLED).
// PayPal ends a hold 29 days after the donor approved it, and a reauthorize keeps
// that day: going on needs a NEW order the donor approves again. No e-mails: this
// card is the reminder, brighter in the last 3 days. The server decides; this only
// shows what /api/pledges/:id/statement offers. Same tokens as RebindOffer.

const card: CSSProperties = { margin: "9.6px 10px 0", padding: "10px 12px 11px", background: "var(--surface)", border: "1px solid var(--card-line)", borderRadius: "var(--r-card)" };
const loud: CSSProperties = { ...card, borderColor: "var(--btn)", boxShadow: "inset 3px 0 0 var(--btn)" };
const h2: CSSProperties = { fontSize: 14, lineHeight: "20px", fontWeight: 700, letterSpacing: "-.55px" };
const p: CSSProperties = { marginTop: 4, fontSize: 12.2, lineHeight: "16.5px", letterSpacing: "-.3px", color: "var(--slate)" };
const btn: CSSProperties = { display: "block", marginTop: 10, width: "100%", height: 34.3, border: 0, borderRadius: "var(--r-btn)", background: "var(--btn)", color: "var(--surface)", fontSize: 12.6, fontWeight: 600, cursor: "pointer" };
const quiet: CSSProperties = { ...btn, background: "transparent", color: "var(--teal-ink)", border: "1px solid var(--card-line)", marginTop: 6 };
const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export interface RenewOfferProps {
  pledgeId: string;
  /** null or absent while the feature is off: nothing is shown. */
  offer: StatementView["renewal"] | undefined;
  /** The hold's need, for the PayPal script's namespace. */
  needId: string | null;
  /** Called after a change that stays on this page (a renewal withdrawn), so the page re-reads the statement. */
  onChanged?: () => void;
}

const daysLeft = (iso: string): number => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

export function RenewOffer({ pledgeId, offer, needId, onChanged }: RenewOfferProps) {
  const router = useRouter();
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);
  // The renewal's pledge id, set when PayPal's button asks for the order and read when the donor approves.
  const renewalId = useRef<string | null>(null);
  if (!offer) return null;
  const open = (id: string) => {
    setMessage(null);
    router.push(`/pledge/${encodeURIComponent(id)}`);
  };
  const changed = () => (onChanged ? onChanged() : router.refresh());
  const link = (id: string, text: string) => (
    <Link href={`/pledge/${encodeURIComponent(id)}`} style={{ color: "var(--teal-ink)", fontWeight: 600 }}>
      {text}
    </Link>
  );
  const renewsLine = offer.renews ? (
    <p style={p} data-testid="renew-of">
      This hold renews {link(offer.renews, "your earlier one")}: same need, same exchange rate. You are never charged more than you first pledged.
    </p>
  ) : null;
  const alert = (message || action.error) && (
    <p style={{ ...p, color: "var(--no)" }} role="alert">
      {message ?? action.error!.error.message}
    </p>
  );

  if (offer.renewedTo) {
    const released = offer.status === "voided" || offer.status === "expired";
    return (
      <section style={card} aria-label="Your hold was renewed" data-testid="renew-done">
        <h2 style={h2}>You renewed this hold</h2>
        <p style={p}>
          You approved a new PayPal order for what was left. {link(offer.renewedTo, "Your new hold")} carries on for the same need.{" "}
          {released
            ? "This one paid for what it had already bought, then PayPal released it: its rest was never charged."
            : "This one first pays for what it has already bought, then PayPal releases it: its rest is never charged."}
        </p>
        {renewsLine}
      </section>
    );
  }

  // The donor's approval for a renewal: PayPal's window, or a demo drive's test card.
  const approveButton = (label: string) =>
    offer.approval === "sandbox_test_card" ? (
      <>
        <button type="button" style={btn} disabled={action.busy === "renew"} onClick={renewNow} data-testid="renew-button">
          {action.busy === "renew" ? "Renewing…" : label}
        </button>
        <p style={p}>Demo drive: PayPal&apos;s sandbox test card approves the new order, as it approved this hold. A real donor approves it in the PayPal window.</p>
      </>
    ) : CLIENT_ID ? (
      <div style={{ marginTop: 10 }} data-testid="renew-paypal">
        <PayPalScriptProvider options={pledgeScriptOptions(CLIENT_ID, offer.available.currency, `renew_${needId ?? "drive"}`)}>
          <PayPalButtons
            style={{ layout: "horizontal", color: "gold", shape: "rect", label: "paypal", height: 40, tagline: false }}
            createOrder={async () => {
              setMessage(null);
              try {
                const r = await api<{ pledgeId: string; orderId: string }>(`/api/pledges/${encodeURIComponent(pledgeId)}/renew`, { json: {} });
                renewalId.current = r.pledgeId;
                return r.orderId;
              } catch (e) {
                setMessage(errorText(e));
                throw e;
              }
            }}
            onApprove={async (data: { orderID: string }) => {
              const id = renewalId.current ?? offer.pending?.pledgeId ?? null;
              if (!id) return;
              try {
                const r = await api<{ status: string }>(`/api/pledges/${encodeURIComponent(id)}/approve`, { json: { orderId: data.orderID } });
                if (r.status === "denied") setMessage("PayPal declined the new hold. Your current hold stays as it is.");
                else open(id);
              } catch (e) {
                setMessage(errorText(e));
              }
            }}
            onCancel={() => setMessage("You closed the PayPal window. Your current hold stays as it is.")}
            onError={() => setMessage((m) => m ?? "PayPal could not open the renewal. Your current hold stays as it is. Try again.")}
          />
        </PayPalScriptProvider>
      </div>
    ) : (
      <p style={p}>PayPal checkout is not configured on this server, so the hold cannot be renewed here.</p>
    );

  function renewNow() {
    action.run("renew", async () => {
      const r = await api<{ pledgeId: string; status: string }>(`/api/pledges/${encodeURIComponent(pledgeId)}/renew`, { json: {} });
      if (r.status === "denied") setMessage("PayPal declined the new hold. Your current hold stays as it is.");
      else if (r.status === "authorized" || r.status === "partially_captured") open(r.pledgeId);
      else setMessage("The renewal waits for PayPal's approval.");
    });
  }

  if (offer.pending) {
    const asked = money(offer.pending.amount.currency, offer.pending.amount.minor);
    const withdraw = () =>
      action.run("withdraw", async () => {
        await api(`/api/pledges/${encodeURIComponent(offer.pending!.pledgeId)}/revoke`, { json: {} });
        changed();
      });
    return (
      <section style={loud} aria-label="A renewal waits for you" data-testid="renew-pending">
        <h2 style={h2}>{offer.pending.approved ? "Your renewal is approved" : `A renewal for ${asked} waits for your approval`}</h2>
        <p style={p}>
          {offer.pending.approved
            ? "PayPal approved the new order; the book is linking it to this hold. Reload in a moment."
            : `You started a renewal: a new PayPal order for ${asked}. Approve it in PayPal to carry this hold on, or withdraw it. Until you approve, nothing changes here.`}
        </p>
        {!offer.pending.approved && (
          <>
            {approveButton(`Approve the renewal of ${asked}`)}
            <button type="button" style={quiet} disabled={action.busy === "withdraw"} onClick={withdraw} data-testid="renew-withdraw">
              {action.busy === "withdraw" ? "Withdrawing…" : "Withdraw this renewal"}
            </button>
          </>
        )}
        {alert}
      </section>
    );
  }

  if (offer.refusal || !offer.expiresAt || offer.available.minor <= 0) {
    if (offer.refusal?.code === "expired" && offer.expiresAt) {
      return (
        <section style={card} aria-label="Your hold ended" data-testid="renew-ended">
          <h2 style={h2}>Your hold ended on {day(offer.expiresAt)}</h2>
          <p style={p}>PayPal ends a hold 29 days after you approve it. What it had not paid for was never charged.</p>
          {renewsLine}
        </section>
      );
    }
    return renewsLine ? (
      <section style={card} aria-label="A renewed hold" data-testid="renew-chain">
        {renewsLine}
      </section>
    ) : null;
  }

  const left = money(offer.available.currency, offer.available.minor);
  const ends = day(offer.expiresAt);
  const n = daysLeft(offer.expiresAt);
  return (
    <section style={offer.remind ? loud : card} aria-label="The end of your hold" data-testid={offer.remind ? "renew-remind" : "renew-offer"}>
      <h2 style={h2}>{offer.remind ? `Your hold ends in ${n} day${n === 1 ? "" : "s"}` : `Your hold runs until ${ends}`}</h2>
      <p style={p}>
        PayPal ends a hold 29 days after you approve it, here on {ends}. {left} of it has not paid for anything yet. To keep it for this drive after that day, renew it: a new PayPal order for {left}, which you approve again. The new order charges nothing now. This hold first pays for what it already bought, then PayPal releases it.
      </p>
      {renewsLine}
      {approveButton(`Renew ${left} for 29 more days`)}
      {alert}
    </section>
  );
}
