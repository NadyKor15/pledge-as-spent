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
  // On a real drive only its coordinator invites and changes volunteers, with the coordinator's key, which this page does
  // not send: the list is read-only here and says so, instead of buttons the server would answer with a refusal.
  const canChange = view.features?.invites === true && view.drive.demo;
  const cur = view.drive.baseCurrency;
  // The limit as the server takes it: "none" for an empty field, whole minor units otherwise; a typo is null (blocked).
  const toLimit = (t: string): number | "none" | null => {
    const v = t.trim().replace(/,/g, "");
    if (!v) return "none";
    const ok = cur === "JPY" ? /^\d+$/.test(v) : /^\d+(\.\d{1,2})?$/.test(v);
    if (!ok) return null;
    const n = cur === "JPY" ? Number(v) : Math.round(Number(v) * 100);
    return n > 0 ? n : null;
  };
  const badLimit = toLimit(limit) === null;
  const base = `/api/drives/${encodeURIComponent(view.drive.id)}/volunteers`;
  const invite = () =>
    action.run("invite", async () => {
      const r = await api<{ token: string; uploadPath: string }>(base, { json: { name, payoutEmail: email, limitMinor: toLimit(limit) } });
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
          {v.id === "demo-volunteer" && <span>demo: the first-receipt check is skipped for this volunteer; on a real drive a person checks each new volunteer&apos;s first receipt</span>}
          {view.receipts.some((r) => r.volunteerId === v.id && r.payoutWaits) && <span style={{ color: "var(--wait)" }}>a payout waits for a higher limit</span>}
          {/* the demo's own volunteer stays as it is (the judges' path rests on it): no buttons the server would refuse */}
          {v.active && canChange && v.id !== "demo-volunteer" && (
            <>
              {editing?.id === v.id ? (
                <form style={{ display: "inline-flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); const l = toLimit(editing.value); if (l !== null) void change(v.id, { action: "limit", limitMinor: l }).then(() => setEditing(null)); }}>
                  <input style={{ ...inp, width: 110 }} autoFocus inputMode="decimal" placeholder="no limit" value={editing.value} onChange={(e) => setEditing({ id: v.id, value: e.target.value })} aria-invalid={toLimit(editing.value) === null} aria-label={`New limit for ${v.name} in ${cur}, empty for none`} />
                  <button type="submit" style={btn} disabled={action.busy === `v-${v.id}` || toLimit(editing.value) === null}>Save</button>
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
      {view.features?.invites && !view.drive.demo && (
        <p style={p} data-testid="volunteers-coordinator-only">
          On a real drive only its coordinator invites, limits and removes volunteers, with the drive&apos;s coordinator key. This page shows who is invited.
        </p>
      )}
      {canChange && (
        <form style={{ ...row, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void invite(); }} aria-label="Invite a volunteer">
          <input style={{ ...inp, flex: "1 1 120px" }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Volunteer's name" />
          <input style={{ ...inp, flex: "2 1 180px" }} placeholder="PayPal email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Volunteer's PayPal email" />
          <input style={{ ...inp, flex: "0 1 110px" }} placeholder={`Limit, ${cur}`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label={`Limit in ${cur}, optional`} />
          <button type="submit" style={btn} disabled={action.busy === "invite" || !name.trim() || !email.trim() || badLimit} title={badLimit ? `A limit is a plain amount in ${cur}, like 500` : undefined}>
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
