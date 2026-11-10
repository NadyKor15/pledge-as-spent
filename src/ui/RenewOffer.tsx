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
const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export interface RenewOfferProps {
  pledgeId: string;
  /** null while the feature is off: nothing is shown. */
  offer: StatementView["renewal"];
  /** The hold's need, for the PayPal script's namespace. */
  needId: string | null;
}

const daysLeft = (iso: string): number => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

export function RenewOffer({ pledgeId, offer, needId }: RenewOfferProps) {
  const router = useRouter();
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);
  // The renewal's pledge id, set when PayPal's button asks for the order and read when the donor approves.
  const renewalId = useRef<string | null>(null);
  if (!offer) return null;
  const open = (id: string) => router.push(`/pledge/${encodeURIComponent(id)}`);
  const link = (id: string, text: string) => (
    <Link href={`/pledge/${encodeURIComponent(id)}`} style={{ color: "var(--teal-ink)", fontWeight: 600 }}>
      {text}
    </Link>
  );

  if (offer.renewedTo) {
    return (
      <section style={card} aria-label="Your hold was renewed" data-testid="renew-done">
        <h2 style={h2}>You renewed this hold</h2>
        <p style={p}>
          You approved a new PayPal order for what was left. {link(offer.renewedTo, "Your new hold")} carries on for the same need. This one paid for what it had already bought, then PayPal let it go: the rest of it was never charged.
        </p>
      </section>
    );
  }

  const renewsLine = offer.renews ? (
    <p style={p} data-testid="renew-of">
      This hold renews {link(offer.renews, "your earlier one")}: same need, same exchange rate, never more than you first pledged.
    </p>
  ) : null;

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
  const title = offer.remind ? `Your hold ends in ${daysLeft(offer.expiresAt)} day${daysLeft(offer.expiresAt) === 1 ? "" : "s"}` : `Your hold runs until ${ends}`;
  const done = (id: string) => {
    setMessage(null);
    open(id);
  };
  const renewNow = () =>
    action.run("renew", async () => {
      const r = await api<{ pledgeId: string; status: string }>(`/api/pledges/${encodeURIComponent(pledgeId)}/renew`, { json: {} });
      done(r.pledgeId);
    });
  const waiting = offer.pending?.pledgeId ?? null;

  return (
    <section style={offer.remind ? loud : card} aria-label="The end of your hold" data-testid={offer.remind ? "renew-remind" : "renew-offer"}>
      <h2 style={h2}>{title}</h2>
      <p style={p}>
        PayPal ends a hold 29 days after you approve it, here on {ends}. {left} of it has not paid for anything yet. To keep it for this drive after that day, renew it: a new PayPal order for {left}, which you approve again. Nothing is charged now. This hold pays for what it already bought, then PayPal lets it go.
      </p>
      {renewsLine}
      {offer.pending && <p style={{ ...p, color: "var(--ink)" }} data-testid="renew-pending">A renewal for {left} waits for your approval in PayPal.</p>}
      {offer.approval === "sandbox_test_card" ? (
        <>
          <button type="button" style={btn} disabled={action.busy === "renew"} onClick={renewNow} data-testid="renew-button">
            {action.busy === "renew" ? "Renewing…" : `Renew ${left} for 29 more days`}
          </button>
          <p style={p}>Demo drive: PayPal&apos;s sandbox test card approves the new order, as it approved your first hold. A real donor approves it in the PayPal window.</p>
        </>
      ) : CLIENT_ID ? (
        <div style={{ marginTop: 10 }}>
          <PayPalScriptProvider options={pledgeScriptOptions(CLIENT_ID, offer.available.currency, `renew_${needId ?? "drive"}`)}>
            <PayPalButtons
              style={{ layout: "horizontal", color: "gold", shape: "rect", label: "paypal", height: 40, tagline: false }}
              createOrder={async () => {
                setMessage(null);
                const r = await api<{ pledgeId: string; orderId: string }>(`/api/pledges/${encodeURIComponent(pledgeId)}/renew`, { json: {} });
                renewalId.current = r.pledgeId;
                return r.orderId;
              }}
              onApprove={async (data: { orderID: string }) => {
                const id = renewalId.current ?? waiting;
                if (!id) return;
                try {
                  const r = await api<{ status: string }>(`/api/pledges/${encodeURIComponent(id)}/approve`, { json: { orderId: data.orderID } });
                  if (r.status === "denied") setMessage("PayPal declined the new hold. Your current hold stays as it is.");
                  else done(id);
                } catch (e) {
                  setMessage(errorText(e));
                }
              }}
              onCancel={() => setMessage("You closed the PayPal window. Your current hold stays as it is.")}
              onError={() => setMessage("PayPal could not open the renewal. Your current hold stays as it is. Try again.")}
            />
          </PayPalScriptProvider>
        </div>
      ) : (
        <p style={p}>PayPal checkout is not configured on this server, so the hold cannot be renewed here.</p>
      )}
      {(message || action.error) && (
        <p style={{ ...p, color: "var(--no)" }} role="alert">
          {message ?? action.error!.error.message}
        </p>
      )}
    </section>
  );
}
