"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HOLD_LIFE_DAYS } from "@/core/time";
import { api, errorText } from "./api";
import { classes } from "./cls";
import { INPUT_CURRENCIES as CURRENCIES, MAX_MAJOR, showMinor, toMinor, type InputCurrency as Currency } from "./money-input";
import { pledgeScriptOptions } from "./pledge-paypal";

const s = classes("dn");

// A donor pledge through the PayPal window: the order is created on our server
// (intent AUTHORIZE), the donor approves it at PayPal, and our server
// authorizes it. Nothing is captured here: the hold waits for a verified receipt.
// Amounts are read by money-input: "20,50" is €20.50, never €2,050.

const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export function PledgeForm({
  driveId,
  needId,
  needLabel,
  restChoice = false,
  rulesOn = false,
  needs = [],
  unit = "unit",
}: {
  driveId: string;
  needId: string;
  needLabel: string;
  restChoice?: boolean;
  /** DONOR_RULES: the donor may limit the lines the hold pays. */
  rulesOn?: boolean;
  /** The drive's needs, for "only these needs". */
  needs?: { id: string; label: string }[];
  /** The need's unit, for "at most X per unit". */
  unit?: string;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [cap, setCap] = useState("");
  const rulesRef = useRef<{ needs?: string[]; maxUnitMinor?: number } | null>(null);
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
  // The donor's rules, as the server takes them: the needs still allowed (only when some are left out) and a cap per unit.
  // a price per unit, not a pledge: no pledge ceiling ("at most ¥15,000 a heater")
  const capMinor = cap.trim() ? toMinor(cap, currency, { ceiling: false }) : undefined;
  const rulesShown = rulesOn && rulesOpen;
  // A cap that cannot be read stops the pledge: dropping it would hold money the donor limited.
  const badCap = rulesShown && capMinor === null;
  const capBlocked = useRef(false);
  // Read when PayPal's button asks for the order (its callback is not re-made on every keystroke), so kept in a ref.
  useEffect(() => {
    const r = !rulesShown ? null : { ...(excluded.length ? { needs: needs.map((n) => n.id).filter((id) => id === needId || !excluded.includes(id)) } : {}), ...(capMinor ? { maxUnitMinor: capMinor } : {}) };
    rulesRef.current = r && (r.needs || r.maxUnitMinor) ? r : null;
    capBlocked.current = badCap;
  }, [rulesShown, excluded, capMinor, badCap, needs, needId]);
  const invalid = minor === null;
  const blocked = invalid || badCap;
  const ruled = rulesShown && (excluded.length > 0 || !!capMinor);
  const carryNote = `It moves to the open need furthest from covered${ruled ? `, among the needs your rules allow${capMinor ? ` that are counted per ${unit}` : ""}` : ""}. Still only approved receipt lines are charged.`;
  const id = `pledge-${needId}`;

  const createOrder = async () => {
    setMessage(null);
    if (minor === null) throw new Error("Enter an amount first.");
    if (capBlocked.current) throw new Error("Fix the most per unit first, or leave it empty.");
    const res = await api<{ pledgeId: string; orderId: string }>(`/api/drives/${encodeURIComponent(driveId)}/pledges`, {
      json: {
        needId,
        donorName: donorName.current.trim() || "Anonymous donor",
        amount: { currency, minor },
        ...(restChoice ? { rest: restRef.current } : {}),
        ...(rulesOn && rulesRef.current ? { rules: rulesRef.current } : {}),
      },
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
              ["carry", "Keeps buying for this drive", carryNote],
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
      {rulesOn && (
        <fieldset className={s.restChoice} data-testid="donor-rules">
          <legend>
            <label className={s.restOpt}>
              <input type="checkbox" checked={rulesOpen} onChange={(e) => setRulesOpen(e.target.checked)} />
              <span>
                <b>Set rules for the lines your hold pays</b> (optional)
              </span>
            </label>
          </legend>
          {rulesOpen && (
            <>
              <div className={`${s.restOpt} ${s.needsPick}`} role="group" aria-label="Needs your hold may pay">
                <span>Only these needs:</span>
                {needs.map((n) => (
                  <label key={n.id}>
                    <input
                      type="checkbox"
                      checked={n.id === needId || !excluded.includes(n.id)}
                      disabled={n.id === needId}
                      onChange={(e) => setExcluded((x) => (e.target.checked ? x.filter((id) => id !== n.id) : [...x, n.id]))}
                    />{" "}
                    {n.label}
                  </label>
                ))}
              </div>
              <label className={s.restOpt}>
                <span>
                  At most{" "}
                  <input className={s.inp} style={{ width: 90, height: 28, fontSize: 14 }} value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="any" aria-invalid={badCap} aria-label={`Most per ${unit}, in ${currency}`} />{" "}
                  {currency} per {unit}, its share of tax included. A dearer line is paid by the other donors.
                </span>
              </label>
              {capMinor ? (
                <p className={s.restOpt} data-testid="rules-cap-read">
                  Read as: at most {showMinor(capMinor, currency)} per {unit}.
                </p>
              ) : badCap ? (
                <p className={`${s.restOpt} ${s.err}`} role="alert" data-testid="rules-cap-error">
                  {currency === "JPY" ? `Write whole yen, like 120.` : `Write it like 0.80 or 0,80.`} Or leave it empty for no price limit.
                </p>
              ) : null}
            </>
          )}
        </fieldset>
      )}
      <p className={s.payNote}>PayPal will say “Pay” — your money is only held until a verified purchase</p>
      {CLIENT_ID ? (
        <div className={s.ppSlot}>
          {/* One form per need on a page: without its own namespace each provider tears down the others' buttons. */}
          <PayPalScriptProvider key={currency} options={pledgeScriptOptions(CLIENT_ID, currency, needId)}>
            <PayPalButtons
              style={{ layout: "horizontal", color: "gold", shape: "rect", label: "paypal", height: 52, tagline: false }}
              disabled={blocked}
              forceReRender={[minor, currency, blocked]}
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
