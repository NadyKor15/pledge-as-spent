"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { HOLD_LIFE_DAYS } from "@/core/time";
import { api, errorText } from "./api";
import { classes } from "./cls";

const s = classes("dn");

// A donor pledge through the PayPal window: the order is created on our server
// (intent AUTHORIZE), the donor approves it at PayPal, and our server
// authorizes it. Nothing is captured here: the hold waits for a verified receipt.

const CURRENCIES = ["EUR", "USD", "JPY"] as const;
type Currency = (typeof CURRENCIES)[number];
/** The API's ceiling for one pledge, in major units. */
const MAX_MAJOR = 10_000;
const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

/** "20.00" EUR -> 2000; null when not a valid amount for the currency. */
export function toMinor(text: string, currency: Currency): number | null {
  const t = text.trim().replace(/,/g, "");
  const re = currency === "JPY" ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(t)) return null;
  const minor = currency === "JPY" ? Number(t) : Math.round(Number(t) * 100);
  const max = MAX_MAJOR * (currency === "JPY" ? 1 : 100);
  return minor > 0 && minor <= max ? minor : null;
}

export function PledgeForm({ driveId, needId, needLabel }: { driveId: string; needId: string; needLabel: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("20.00");
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [message, setMessage] = useState<string | null>(null);
  const pledgeId = useRef<string | null>(null);
  const minor = toMinor(amount, currency);
  const invalid = amount.trim() !== "" && minor === null;
  const id = `pledge-${needId}`;

  const createOrder = async () => {
    setMessage(null);
    if (minor === null) throw new Error("Enter an amount first.");
    const res = await api<{ pledgeId: string; orderId: string }>(`/api/drives/${encodeURIComponent(driveId)}/pledges`, {
      json: { needId, donorName: name.trim() || "Anonymous donor", amount: { currency, minor } },
    });
    pledgeId.current = res.pledgeId;
    return res.orderId;
  };

  const onApprove = async (data: { orderID: string }) => {
    const pid = pledgeId.current;
    if (!pid) return;
    try {
      const res = await api<{ status: string }>(`/api/pledges/${encodeURIComponent(pid)}/approve`, { json: { orderId: data.orderID } });
      if (res.status === "denied") setMessage("PayPal declined the hold. Nothing was charged.");
      else router.push(`/pledge/${encodeURIComponent(pid)}`);
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <form className={s.pledgeForm} onSubmit={(e) => e.preventDefault()} aria-label={`Pledge for ${needLabel}`}>
      <div className={s.pfCols}>
        <div>
          <label htmlFor={`${id}-name`}>Your name</label>
          <input id={`${id}-name`} className={`${s.inp} ${s.name}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Anonymous" maxLength={80} autoComplete="given-name" />
        </div>
        <div>
          <label htmlFor={`${id}-amount`}>Your pledge amount</label>
          <input id={`${id}-amount`} className={s.inp} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-invalid={invalid} />
        </div>
        <div>
          <label htmlFor={`${id}-currency`}>Currency</label>
          <select id={`${id}-currency`} className={s.inp} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <p className={s.payNote}>PayPal will say “Pay” — your money is only held until a verified purchase</p>
      {CLIENT_ID ? (
        <div className={s.ppSlot}>
          <PayPalScriptProvider key={currency} options={{ clientId: CLIENT_ID, intent: "authorize", currency, components: "buttons", commit: true }}>
            <PayPalButtons
              style={{ layout: "horizontal", color: "gold", shape: "rect", label: "paypal", height: 52, tagline: false }}
              disabled={minor === null}
              forceReRender={[minor, currency, name]}
              createOrder={createOrder}
              onApprove={onApprove}
              onCancel={() => setMessage("You closed the PayPal window. Nothing was held.")}
              onError={(err) => setMessage(err instanceof Error ? err.message : "PayPal could not open the pledge. Try again.")}
            />
          </PayPalScriptProvider>
        </div>
      ) : (
        <button type="button" className={s.btnPp} onClick={() => setMessage("PayPal checkout is not configured on this server, so no pledge can be placed here.")}>
          Pledge with
          <span className={s.pp}>
            <b>Pay</b>
            <em>Pal</em>
          </span>
        </button>
      )}
      <p className={`${s.pfHint} ${message || invalid ? s.err : ""}`} role={message ? "alert" : undefined}>
        {message ??
          (invalid
            ? `Enter an amount up to ${MAX_MAJOR.toLocaleString("en-US")} ${currency}${currency === "JPY" ? " in whole yen" : ", with at most two decimals"}.`
            : `Held on your PayPal account for up to ${HOLD_LIFE_DAYS} days, then released.`)}
      </p>
    </form>
  );
}
