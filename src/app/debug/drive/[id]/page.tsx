import { connection } from "next/server";
import { Suspense } from "react";
import type { DriveView } from "@/server/service";

// Unstyled debug view of one drive: the book as tables, plus forms that post to
// the API and come back here. Not the product screens. It reads the drive from
// its own JSON API, so it shows exactly what the API returns and keeps the
// database out of the page bundle.

export default function DriveDebugPage({ params }: PageProps<"/debug/drive/[id]">) {
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <Suspense fallback={<p>Loading the book…</p>}>
        <DriveDebug params={params} />
      </Suspense>
    </main>
  );
}

const amount = (currency: string | null, minor: number | null) =>
  currency === null || minor === null ? "" : currency === "JPY" ? `¥${minor.toLocaleString("en-US")}` : `${currency} ${(minor / 100).toFixed(2)}`;

function Table({ rows, cols }: { rows: Record<string, unknown>[]; cols: string[] }) {
  return (
    <table border={1} cellPadding={4} style={{ borderCollapse: "collapse", marginBottom: 16 }}>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => (
              <td key={c}>{typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : String(r[c] ?? "")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function DriveDebug({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  // Never the request's Host header: that would let a caller aim this fetch at any host.
  const origin = (process.env.APP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, "");
  const res = await fetch(`${origin}/api/drives/${encodeURIComponent(id)}`);
  const body = await res.json();
  if (!res.ok) return <p>{String(body.message ?? res.status)}</p>;
  const v = body as DriveView;
  const back = `/debug/drive/${id}`;
  const base = v.drive.baseCurrency;
  return (
    <>
      <h1>
        {v.drive.title} ({v.drive.id}) — {v.drive.status}
      </h1>
      <p>
        Base currency {base}; disaster date {v.drive.disasterDate}; zone {v.drive.zone.join(", ")}; {v.eventCount} events in the book.
      </p>

      <h2>Actions</h2>
      <form method="post" action={`/api/drives/${id}/receipts`} encType="multipart/form-data">
        <input type="hidden" name="back" value={back} />
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp" /> <button type="submit">Upload receipt</button>
      </form>
      <form method="post" action={`/api/drives/${id}/receipts`} encType="multipart/form-data">
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="sample" value="hero" />
        <button type="submit">Upload the sample receipt</button>
      </form>
      <form method="post" action={`/api/drives/${id}/capture-now`}>
        <input type="hidden" name="back" value={back} />
        <button type="submit">Capture now</button>
      </form>
      <form method="post" action={`/api/drives/${id}/close`}>
        <input type="hidden" name="back" value={back} />
        <button type="submit">Close the drive</button>
      </form>
      <form method="post" action="/api/demo/drives">
        <input type="hidden" name="back" value="1" />
        <button type="submit">New demo drive</button>
      </form>

      <h2>Needs</h2>
      <Table
        rows={v.needs.map((n) => ({ ...n, funded: amount(base, n.fundedBase), donors: amount(base, n.donorBase), match: amount(base, n.matchBase), unfunded: amount(base, n.unfundedBase) }))}
        cols={["needId", "label", "qtyCovered", "qtyNeeded", "funded", "donors", "match", "unfunded"]}
      />

      <h2>Holds</h2>
      <Table
        rows={v.holds.map((h) => ({
          ...h,
          pledged: amount(h.currency, h.pledged),
          captured: amount(h.currency, h.captured),
          pending: amount(h.currency, h.capturePending),
          accrued: amount(h.currency, h.accrued),
          released: amount(h.currency, h.released),
          available: amount(h.currency, h.available),
          rate: `1 ${h.fx.quote} = ${h.fx.rate} ${h.fx.base}`,
        }))}
        cols={["pledgeId", "donorName", "kind", "status", "pledged", "captured", "pending", "accrued", "released", "available", "rate", "orderId", "authorizationId"]}
      />

      <h2>Ledger</h2>
      <Table
        rows={v.ledger.map((r) => ({ ...r, base: amount(base, r.base), charge: amount(r.currency, r.amount), match: amount(base, r.matchBase) }))}
        cols={["receiptId", "lineNo", "item", "qty", "kind", "donorName", "base", "charge", "match", "status", "captureId", "code", "reasonEn"]}
      />

      <h2>Receipts</h2>
      {v.receipts.map((r) => (
        <section key={r.id} style={{ marginBottom: 16 }}>
          <h3>
            {r.id} — {r.status} ({r.reader}, {r.channel})
          </h3>
          <p>
            {r.merchant} {r.purchasedAt} total {amount(r.currency, r.total)}
          </p>
          {r.flags.length > 0 && (
            <ul>
              {r.flags.map((f) => (
                <li key={f.code}>
                  {f.severity}: {f.messageEn}
                </li>
              ))}
            </ul>
          )}
          {r.status === "review" && (
            <form method="post" action={`/api/receipts/${encodeURIComponent(r.id)}/decision`}>
              <input type="hidden" name="back" value={back} />
              <input name="reason" placeholder="reason" required />{" "}
              <button type="submit" name="decision" value="approve">
                Approve
              </button>{" "}
              <button type="submit" name="decision" value="reject">
                Reject
              </button>
            </form>
          )}
          <Table rows={r.lines} cols={["lineNo", "text", "translationEn", "amount", "verdict", "needId", "needQty", "ruleCode", "reasonEn"]} />
          {/* eslint-disable-next-line @next/next/no-img-element -- debug page: the API serves the blurred copy */}
          {r.image.published ? <img src={r.image.url} alt={`receipt ${r.id}, only its purchase lines shown`} width={240} /> : <p>{r.image.note}</p>}
        </section>
      ))}

      <h2>Payouts</h2>
      <Table rows={v.payouts.flatMap((p) => p.attempts.map((a) => ({ receiptId: p.receiptId, ...a, amount: amount(base, a.amount) })))} cols={["receiptId", "senderBatchId", "amount", "status", "payoutBatchId", "fee", "failReason"]} />

      <h2>Close report</h2>
      <Table rows={v.closeReport.map((c) => ({ ...c, pledged: amount(c.currency, c.pledged), spent: amount(c.currency, c.spent), released: amount(c.currency, c.released) }))} cols={["pledgeId", "donorName", "pledged", "spent", "released", "settled"]} />

      <h2>Fees saved by batching</h2>
      <Table rows={v.feeSavings.map((f) => ({ ...f, saved: amount(f.currency, f.savedMinor), paypalFee: amount(f.currency, f.paypalFeeMinor) }))} cols={["currency", "batches", "shares", "saved", "paypalFee", "estimate", "source"]} />

      <h2>PayPal journal</h2>
      <Table rows={v.paypal} cols={["ts", "method", "path", "requestId", "httpStatus", "debugId", "ids"]} />
    </>
  );
}
