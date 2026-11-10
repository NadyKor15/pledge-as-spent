"use client";

import { useState, type CSSProperties } from "react";
import { api, useAction } from "./api";
import { day, money } from "./format";
import type { DriveView } from "./types";

// The coordinator's invited volunteers (VOLUNTEER_INVITES): who may upload receipts and
// be paid, their PayPal address masked, what they were paid, their limit. Inviting gives
// a personal upload link ONCE (the server keeps only its hash). Sits inside the
// coordinator page (.co-page) and uses its tokens. The server decides; this only asks it.

const card: CSSProperties = { margin: "12px 0 0", padding: "12px 14px 13px", background: "var(--panel)", border: "1px solid var(--card-line)", borderRadius: 10 };
const h2: CSSProperties = { fontSize: 15, lineHeight: "20px", fontWeight: 700, color: "var(--ink)" };
const p: CSSProperties = { marginTop: 4, fontSize: 13, lineHeight: "17px", color: "var(--ink-3)" };
const row: CSSProperties = { display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, fontSize: 13.5, color: "var(--ink-2)", flexWrap: "wrap" };
const inp: CSSProperties = { height: 30, padding: "0 8px", border: "1px solid var(--card-line)", borderRadius: 6, fontSize: 13.5, minWidth: 0 };
const btn: CSSProperties = { height: 30, padding: "0 12px", border: 0, borderRadius: 6, background: "var(--btn)", color: "var(--on-btn)", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const quiet: CSSProperties = { ...btn, background: "transparent", color: "var(--btn)", border: "1px solid var(--card-line)" };

export function VolunteersCard({ view, refresh }: { view: DriveView; refresh: () => Promise<unknown> }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [limit, setLimit] = useState("");
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  if (!view.features?.invites && !view.volunteers?.length) return null;
  const cur = view.drive.baseCurrency;
  const toMinor = (t: string): number | null => {
    const v = t.trim().replace(/,/g, "");
    if (!v) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(v)) return NaN;
    return cur === "JPY" ? Number(v) : Math.round(Number(v) * 100);
  };
  const base = `/api/drives/${encodeURIComponent(view.drive.id)}/volunteers`;
  const invite = () =>
    action.run("invite", async () => {
      const r = await api<{ token: string; uploadPath: string }>(base, { json: { name, payoutEmail: email, limitMinor: toMinor(limit) } });
      setLink({ name, url: `${window.location.origin}${r.uploadPath}` });
      setName("");
      setEmail("");
      setLimit("");
      await refresh();
    });
  const change = (vid: string, json: Record<string, unknown>) =>
    action.run(`v-${vid}`, async () => {
      await api(`${base}/${encodeURIComponent(vid)}`, { json });
      await refresh();
    });

  return (
    <section style={card} aria-label="Invited volunteers" data-testid="volunteers">
      <h2 style={h2}>Volunteers</h2>
      <p style={p}>Only invited volunteers upload receipts, and payouts go only to their PayPal address. A person checks each new volunteer&apos;s first receipt. A limit caps all one volunteer is paid.</p>
      {(view.volunteers ?? []).map((v) => (
        <div key={v.id} style={{ ...row, opacity: v.active ? 1 : 0.55 }} data-testid="volunteer-row">
          <b style={{ color: "var(--ink)" }}>{v.name}</b>
          <span>PayPal {v.payoutMasked}</span>
          <span>
            paid {money(cur, v.paidBase)}
            {v.pendingBase > 0 ? `, ${money(cur, v.pendingBase)} on its way` : ""}
          </span>
          <span>{v.limitBase === null ? "no limit" : `limit ${money(cur, v.limitBase)}`}</span>
          <span>{v.active ? `invited ${day(v.invitedAt)} by ${v.invitedBy}` : `removed ${day(v.removedAt)}`}</span>
          {v.id === "demo-volunteer" && <span>demo: receipts are funded at once; on a real drive a person checks each new volunteer&apos;s first receipt</span>}
          {v.active && view.features?.invites && (
            <>
              {editing?.id === v.id ? (
                <form style={{ display: "inline-flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); void change(v.id, { action: "limit", limitMinor: toMinor(editing.value) }).then(() => setEditing(null)); }}>
                  <input style={{ ...inp, width: 110 }} autoFocus inputMode="decimal" placeholder="no limit" value={editing.value} onChange={(e) => setEditing({ id: v.id, value: e.target.value })} aria-label={`New limit for ${v.name} in ${cur}, empty for none`} />
                  <button type="submit" style={btn} disabled={action.busy === `v-${v.id}`}>Save</button>
                </form>
              ) : (
                <button type="button" style={quiet} disabled={action.busy === `v-${v.id}`} onClick={() => setEditing({ id: v.id, value: v.limitBase === null ? "" : String(cur === "JPY" ? v.limitBase : v.limitBase / 100) })}>
                  Limit
                </button>
              )}
              <button type="button" style={quiet} disabled={action.busy === `v-${v.id}`} onClick={() => void change(v.id, { action: "remove" })}>
                Remove
              </button>
            </>
          )}
        </div>
      ))}
      {view.features?.invites && (
        <form style={{ ...row, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void invite(); }} aria-label="Invite a volunteer">
          <input style={{ ...inp, flex: "1 1 120px" }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Volunteer's name" />
          <input style={{ ...inp, flex: "2 1 180px" }} placeholder="PayPal email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Volunteer's PayPal email" />
          <input style={{ ...inp, flex: "0 1 110px" }} placeholder={`Limit, ${cur}`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label={`Limit in ${cur}, optional`} />
          <button type="submit" style={btn} disabled={action.busy === "invite" || !name.trim() || !email.trim()}>
            {action.busy === "invite" ? "Inviting…" : "Invite"}
          </button>
        </form>
      )}
      {link && (
        <p style={{ ...p, color: "var(--ink)" }} data-testid="volunteer-link">
          {link.name}&apos;s upload link, shown once: <code style={{ wordBreak: "break-all" }}>{link.url}</code>
        </p>
      )}
      {action.error && (
        <p style={{ ...p, color: "var(--no)" }} role="alert">
          {action.error.error.message}
        </p>
      )}
    </section>
  );
}
