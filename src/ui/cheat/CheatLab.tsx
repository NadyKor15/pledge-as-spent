"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CheatLine, CheatResult, ForgeryCard } from "@/server/cheat";
import { api, asApiError, type ApiError } from "../api";
import { money } from "../format";
import { showcaseLinks } from "../showcase";
import "./cheat.css";

// "Try to cheat the receipt": the judge picks a forged receipt, the server checks it against a copy of the demo drive,
// and the page shows each line's fate and what the forged lines would have cost donors: a sum the server computes
// from the allocation, so a check that let a forged line through would show here as money.
//
// While the next forgery runs, the last result stays on the page, dimmed and inert. Taking it away for that moment
// made the page ~1,700 px shorter on a phone: a reader scrolled down to the lower cards had the page jump under the
// finger (scrollY 520 -> 284), so the next tap could land on a different card.

const OUTCOME: Record<CheatLine["outcome"], string> = { paid: "Paid", refused: "Refused", held: "Held for a person", blocked: "Blocked" };

const amounts = (list: { currency: string; minor: number }[]) => list.map((m) => money(m.currency, m.minor)).join(" · ");

function utcTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(11, 19)} UTC`;
}

export function CheatLab({ forgeries }: { forgeries: ForgeryCard[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<CheatResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Only the latest pick's answer counts: an earlier one arriving late is dropped.
  const latest = useRef(0);

  const run = async (id: string) => {
    const n = ++latest.current;
    setPicked(id);
    setBusy(true);
    setError(null);
    try {
      const r = await api<CheatResult>(`/api/cheat?forgery=${encodeURIComponent(id)}`);
      if (n === latest.current) setResult(r);
    } catch (e) {
      if (n !== latest.current) return;
      setResult(null);
      setError(asApiError(e));
    } finally {
      if (n === latest.current) setBusy(false);
    }
  };

  // The result of the pick on screen, or while a new pick runs, the previous one (stale).
  const shown = result;
  const stale = busy || (result !== null && result.forgery.id !== picked);
  const honest = shown ? shown.chargedHonest.some((m) => m.minor > 0) : false;

  return (
    <main className="ch-page">
      <header className="ch-top">
        <Link className="ch-brand" href="/">
          Pledge-as-Spent
        </Link>
        <span className="ch-badge">Fictional drive · PayPal Sandbox</span>
      </header>

      <section className="ch-intro">
        <h1>Try to cheat the receipt</h1>
        <p>
          Pick a forged receipt. The server sends it to a fresh copy of the demo drive (Kitasora, three needs, four holds, the sample receipt already paid) and runs the same checks every upload meets, line by
          line. Nothing is written and PayPal is not called.
        </p>
      </section>

      <div className="ch-cards" role="group" aria-label="Forged receipts">
        {forgeries.map((f) => (
          <button key={f.id} type="button" className="ch-card" aria-pressed={picked === f.id} onClick={() => void run(f.id)} data-forgery={f.id}>
            <Image src={f.image} alt="" width={300} height={420} unoptimized />
            <span className="ch-card-txt">
              <b>{f.title}</b>
              <span>{f.story}</span>
            </span>
          </button>
        ))}
      </div>

      <section className="ch-result" aria-live="polite" aria-busy={busy}>
        {!picked && <p className="ch-hint">Pick one of the five above.</p>}
        {busy && <p className="ch-hint">Running the checks…</p>}
        {error && (
          <p className="ch-error" role="alert">
            {error.message}
          </p>
        )}
        {shown && (
          <div className={stale ? "ch-out ch-stale" : "ch-out"} data-shown={stale ? undefined : shown.forgery.id} inert={stale || undefined}>
            <div className="ch-score" data-testid="cheat-score">
              <span className="ch-score-label">Charged to donors for forged lines</span>
              <b className="ch-score-sum">{amounts(shown.chargedForged)}</b>
              {honest && <span className="ch-score-honest">Honest lines on the same receipt pass and are paid: {amounts(shown.chargedHonest.filter((m) => m.minor > 0))}.</span>}
            </div>

            <div className="ch-receipt">
              <a href={shown.forgery.image} target="_blank" rel="noopener noreferrer" className="ch-photo">
                <Image src={shown.forgery.image} alt={`${shown.forgery.title}: the receipt, closed to its purchase lines`} width={600} height={820} unoptimized />
              </a>
              <div className="ch-detail">
                <h2>{shown.forgery.title}</h2>
                <p className="ch-meta">
                  {shown.receipt.merchant} · {shown.receipt.address} · {shown.receipt.purchasedAt?.replace("T", " ").slice(0, 16)} · total {money(shown.receipt.currency, shown.receipt.total)}
                </p>
                {shown.flags.length > 0 ? (
                  <ul className="ch-flags">
                    {shown.flags.map((f) => (
                      <li key={f.code} data-severity={f.severity}>
                        <b>{f.severity === "block" ? "Receipt blocked" : "Receipt held for a person"}:</b> {f.messageEn}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ch-noflag">No receipt-wide flag: date, store, totals and fingerprints pass. Each line is judged on its own.</p>
                )}
                <div className="ch-lines" role="table" aria-label="Lines of the receipt">
                  {shown.lines.map((l) => (
                    <div key={l.lineNo} className={`ch-line ch-${l.outcome}`} role="row" data-outcome={l.outcome}>
                      <span role="cell" className="ch-no">
                        {l.lineNo}
                      </span>
                      <span role="cell" className="ch-what">
                        <span className="ch-en">{l.translationEn ?? l.text}</span>
                        <span className="ch-orig" lang="ja">
                          {l.text}
                        </span>
                        {l.forged && <span className="ch-forged">forged</span>}
                      </span>
                      <span role="cell" className="ch-amt">
                        {money(shown.receipt.currency, l.amount)}
                      </span>
                      <span role="cell" className="ch-verdict">
                        <b>{OUTCOME[l.outcome]}</b>
                        <span>{l.reason}</span>
                        {l.charged.length > 0 && <span className="ch-charged">{l.charged.map((c) => `${c.donorName} ${money(c.amount.currency, c.amount.minor)}`).join(" · ")}</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="ch-honesty">Recorded reading — no model call. The reading is the receipt set’s own truth, so this tests the checks, not the AI that reads photos. Checks ran at {utcTime(shown.ranAt)}.</p>
              </div>
            </div>
          </div>
        )}
      </section>

      <p className="ch-more">
        <Link href="/">Open a demo drive</Link> · <Link href={showcaseLinks().ledger}>See a finished drive</Link>
      </p>
    </main>
  );
}
