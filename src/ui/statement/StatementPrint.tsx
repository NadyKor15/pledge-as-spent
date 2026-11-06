"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api, asApiError, useDrive, type ApiError } from "../api";
import { classes } from "../cls";
import { Failure, Loading } from "../states";
import type { StatementView } from "../types";
import { printModel } from "./print-model";
import "./print.css";

const s = classes("sp");

/** `@page` is global, so it exists only while this page does. */
function usePageRule() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = '@page { size: A4 portrait; margin: 14mm 14mm 16mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #475164; } }';
    document.head.append(el);
    return () => el.remove();
  }, []);
}

/** The donor's statement as an A4 page: a button prints it, "Save as PDF" in the print dialog keeps it. */
export function StatementPrintScreen({ params }: { params: Promise<{ pledgeId: string }> }) {
  const { pledgeId } = use(params);
  const [data, setData] = useState<StatementView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  usePageRule();
  useEffect(() => {
    let live = true;
    api<StatementView>(`/api/pledges/${encodeURIComponent(pledgeId)}/statement`).then(
      (v) => live && setData(v),
      (e) => live && setError(asApiError(e)),
    );
    return () => {
      live = false;
    };
  }, [pledgeId]);
  if (!data) {
    if (!error) return <Loading what="your statement" />;
    return <Failure title={error.status === 404 ? "No such pledge" : "The statement could not be loaded"} message={error.message} />;
  }
  return <Sheet data={data} />;
}

function Sheet({ data }: { data: StatementView }) {
  const d = useDrive(data.drive.id);
  const m = printModel(data, { driveTitle: d.view?.drive.displayTitle });
  const [printedAt] = useState(() => new Date());
  const stamp = printedAt.toISOString().slice(0, 16).replace("T", " ");
  return (
    <div className={s.root}>
      <div className={s.bar}>
        <button type="button" className={s.print} onClick={() => window.print()} data-testid="print-statement">
          Save as PDF
        </button>
        <span className={s.hint}>Opens the print dialog: choose “Save as PDF” as the destination.</span>
        <Link className={s.back} href={`/pledge/${encodeURIComponent(data.statement.pledgeId)}`}>
          Back to the statement
        </Link>
      </div>

      <article className={s.sheet} data-testid="statement-sheet">
        <header className={s.head}>
          <div>
            <div className={s.brand}>Pledge-as-Spent</div>
            <h1 className={s.h1}>Donor statement</h1>
          </div>
          <div className={s.stamp}>
            <div>Generated {stamp} UTC</div>
            <div>PayPal Sandbox · fictional drive</div>
          </div>
        </header>

        <dl className={s.who}>
          <div>
            <dt>Donor</dt>
            <dd>{m.donor}</dd>
          </div>
          <div>
            <dt>Drive</dt>
            <dd>{m.driveTitle}</dd>
          </div>
          <div>
            <dt>Pledge</dt>
            <dd className={s.mono}>{m.pledgeId}</dd>
          </div>
          <div>
            <dt>Hold at PayPal</dt>
            <dd className={s.mono}>{m.holdId ?? "none yet"}</dd>
            {m.holdExpires && <dd className={s.small}>expires {m.holdExpires}</dd>}
          </div>
        </dl>

        <h2 className={s.h2}>What the pledge bought</h2>
        {m.rows.length === 0 ? (
          <p className={s.empty}>Nothing was bought with this pledge.</p>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Receipt line</th>
                <th>Item</th>
                <th>Status</th>
                <th className={s.num}>Your share ({m.currency})</th>
                <th className={s.num}>Match ({m.baseCurrency})</th>
                <th>PayPal capture</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.key}>
                  <td className={s.mono}>{r.line}</td>
                  <td>
                    {r.item}
                    <span className={s.sub}>{r.qty}</span>
                  </td>
                  <td>
                    {r.status}
                    {r.note && <span className={s.sub}>{r.note}</span>}
                  </td>
                  <td className={s.num}>{r.share}</td>
                  <td className={s.num}>{r.match}</td>
                  <td className={s.mono}>
                    {r.captureId ?? "—"}
                    {r.requestId && <span className={s.sub}>request {r.requestId}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2 className={s.h2}>Totals</h2>
        <table className={s.totals}>
          <tbody>
            {m.totals.map((t) => (
              <tr key={t.label} className={t.strong ? s.strong : undefined}>
                <th scope="row">{t.label}</th>
                <td className={s.num}>{t.value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className={s.foot}>
          A share is charged only when PayPal confirms the capture; whatever is not spent goes back to you when the drive closes. Match is the company match your share unlocked, in the drive’s currency ({m.baseCurrency}). The capture ids are PayPal’s own: you can look each one up in your PayPal activity.
        </p>
      </article>
    </div>
  );
}
