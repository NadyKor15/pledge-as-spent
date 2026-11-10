"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { HOLD_LIFE_DAYS } from "@/core/time";
import { api, errorText } from "./api";
import { classes } from "./cls";
import { pledgeScriptOptions } from "./pledge-paypal";

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

export function PledgeForm({ driveId, needId, needLabel, restChoice = false }: { driveId: string; needId: string; needLabel: string; restChoice?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("20.00");
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [message, setMessage] = useState<string | null>(null);
  const pledgeId = useRef<string | null>(null);
  // Read when PayPal's button is pressed: a name is no reason to reload the button on every letter.
  const donorName = useRef("");
  // What happens to the rest once this need is covered (shown only when the server has it switched on).
  const [rest, setRest] = useState<"release" | "carry">("release");
  const restRef = useRef<"release" | "carry">("release");
  const minor = toMinor(amount, currency);
  const invalid = minor === null;
  const id = `pledge-${needId}`;

  const createOrder = async () => {
    setMessage(null);
    if (minor === null) throw new Error("Enter an amount first.");
    const res = await api<{ pledgeId: string; orderId: string }>(`/api/drives/${encodeURIComponent(driveId)}/pledges`, {
      json: { needId, donorName: donorName.current.trim() || "Anonymous donor", amount: { currency, minor }, ...(restChoice ? { rest: restRef.current } : {}) },
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
          <input id={`${id}-name`} className={`${s.inp} ${s.name}`} value={name} onChange={(e) => {
                setName(e.target.value);
                donorName.current = e.target.value;
              }} placeholder="Anonymous" maxLength={80} autoComplete="given-name" />
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
      {restChoice && (
        <fieldset className={s.restChoice} data-testid="rest-choice">
          <legend>When {needLabel} is covered, what is left of your hold</legend>
          {(
            [
              ["release", "Is never charged", `Only receipts for ${needLabel} can use your hold.`],
              ["carry", "Keeps buying for this drive", "It moves to the open need that lacks the most. Still only approved receipt lines are charged."],
            ] as const
          ).map(([value, title, note]) => (
            <label key={value} className={s.restOpt}>
              <input
                type="radio"
                name={`rest-${needId}`}
                value={value}
                checked={rest === value}
                onChange={() => {
                  setRest(value);
                  restRef.current = value;
                }}
              />
              <span>
                <b>{title}</b> {note}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <p className={s.payNote}>PayPal will say “Pay” — your money is only held until a verified purchase</p>
      {CLIENT_ID ? (
        <div className={s.ppSlot}>
          {/* One form per need on a page: without its own namespace each provider tears down the others' buttons. */}
          <PayPalScriptProvider key={currency} options={pledgeScriptOptions(CLIENT_ID, currency, needId)}>
            <PayPalButtons
              style={{ layout: "horizontal", color: "gold", shape: "rect", label: "paypal", height: 52, tagline: false }}
              disabled={minor === null}
              forceReRender={[minor, currency]}
              createOrder={createOrder}
              onApprove={onApprove}
              onCancel={() => setMessage("You closed the PayPal window. Nothing was held.")}
              onError={() => setMessage("PayPal could not open the pledge. Nothing was held. Try again.")}
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
            ? `Enter an amount above 0, up to ${MAX_MAJOR.toLocaleString("en-US")} ${currency}${currency === "JPY" ? " in whole yen" : ", with at most two decimals"}.`
            : `Held on your PayPal account for up to ${HOLD_LIFE_DAYS} days, then returned.`)}
      </p>
    </form>
  );
}
