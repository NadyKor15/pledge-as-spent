"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, useAction, type ApiError } from "./api";
import { captureState, focusReceipt, holdAmounts, holdStatusLabel, lineName, lineViews, liveFeed, needById, paypalActivity, receiptChecks, shareGroups, type LineView } from "./derive";
import { LineOriginal } from "./LineOriginal";
import { donorParts, money, ofCount, pct } from "./format";
import { DesktopHeader } from "./Header";
import { Check, Clock, Cross, NeedIcon } from "./icons";
import { curve, drop, useFlows, type Box, type Shape } from "./stage";
import type { DriveView, Hold, Receipt } from "./types";
import "./coordinator.css";
import { classes } from "./cls";

const s = classes("co");

interface Props {
  view: DriveView;
  following: boolean;
  refresh: () => Promise<unknown>;
  follow: () => void;
}

export function CoordinatorView({ view, following, refresh, follow }: Props) {
  const { busy, error, run } = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const receipt = view.receipts.find((r) => r.id === picked) ?? focusReceipt(view);
  const driveId = view.drive.id;
  const page = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);

  const act = async (name: string, path: string, init?: RequestInit & { json?: unknown }) => {
    const ok = await run(name, () => api(path, { method: "POST", ...init }));
    await refresh();
    if (ok !== undefined) follow();
  };
  const sample = () => {
    const body = new FormData();
    body.set("sample", "hero");
    return act("sample", `/api/drives/${encodeURIComponent(driveId)}/receipts`, { body }).then(() => setPicked(null));
  };
  const errorFor = (name: string) => (error?.name === name ? error.error : null);

  const lines = receipt ? lineViews(view, receipt) : [];
  useFlows(page, layer, (box) => flows(view, receipt, lines, box));

  const donors = view.holds.filter((h) => h.kind === "donor");
  const matches = view.holds.filter((h) => h.kind === "match");

  return (
    <div className={s.page} ref={page}>
      <DesktopHeader driveId={driveId} title={view.drive.displayTitle} demo={view.drive.demo} role="coordinator" variant="c" />

      <section className={s.row1}>
        <div className={`${s.panel} ${s.pLeft}`}>
          <h2 className={s.ptitle}>Pledges = PayPal holds</h2>
          <p className={s.psub}>Donors’ funds are held and only captured for verified purchases.</p>
          <div className={s.cards}>
            {donors.map((h) => (
              <HoldCard key={h.pledgeId} hold={h} needLabel={needById(view, h.needId)?.displayLabel ?? ""} />
            ))}
            {matches.map((h) => (
              <MatchCard key={h.pledgeId} hold={h} ratio={view.match.ratio} />
            ))}
          </div>
        </div>

        <div className={`${s.panel} ${s.pMid}`}>
          <h2 className={s.ptitle}>{receipt && receipt.id === view.receipts[view.receipts.length - 1]?.id ? "Latest receipt" : "Receipt"}</h2>
          {view.receipts.length > 1 && (
            <div className={s.pager} role="group" aria-label="Receipts">
              {view.receipts.map((r, i) => (
                <button key={r.id} type="button" aria-pressed={r.id === receipt?.id} className={r.status === "review" ? s.flagged : undefined} onClick={() => setPicked(r.id)} title={r.status}>
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          {receipt ? (
            <ReceiptBody view={view} receipt={receipt} lines={lines} busy={busy} errorFor={errorFor} act={act} />
          ) : (
            <div className={s.emptyReceipt}>
              <p>No receipt yet. Volunteers send one from the Volunteer view; the sample receipt shows the whole flow.</p>
              <button type="button" className={s.ppBtn} style={{ position: "static" }} disabled={busy !== null || view.drive.status !== "open"} onClick={sample}>
                {busy === "sample" ? "Reading the sample receipt…" : "Use the sample receipt"}
              </button>
              {errorFor("sample") && <p className={s.error}>{errorFor("sample")!.message}</p>}
            </div>
          )}
        </div>

        <div className={`${s.panel} ${s.pRight}`}>
          <h2 className={s.ptitle}>Shelter needs / progress</h2>
          <p className={s.psub}>Approved receipt items count toward these needs.</p>
          <div className={s.needs} style={{ marginTop: view.needs.length > 3 ? 24 : 76.9, gap: view.needs.length > 3 ? 18 : 79 }}>
            {view.needs.map((n) => (
              <div className={s.need} key={n.needId} data-flow={`need:${n.needId}`}>
                <div className={s.ico}>
                  <NeedIcon needId={n.needId} size={36} />
                </div>
                <div className={s.nt}>{n.displayLabel}</div>
                <div className={s.nc}>{ofCount(n.qtyCovered, n.qtyNeeded, n.unit)}</div>
                <div className={s.nbar}>
                  <i style={{ width: `${Math.min(100, pct(n.qtyCovered, n.qtyNeeded))}%` }} />
                </div>
                {n.covered && <div className={s.closed}>Closed — fully bought</div>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={s.row2}>
        <WhoPays view={view} />
        <Activity view={view} busy={busy} capture={() => act("capture", `/api/drives/${encodeURIComponent(driveId)}/capture-now`)} error={errorFor("capture")} />
        <ClosePanel view={view} busy={busy} close={() => act("close", `/api/drives/${encodeURIComponent(driveId)}/close`)} error={errorFor("close")} />
      </section>

      <footer className={s.foot}>
        <div className={s.fLive}>Live PayPal activity</div>
        {liveFeed(view, 5).map((f) => (
          <FootItem key={f.key} ok={f.ok} text={f.text} />
        ))}
        {following ? (
          <span className={s.updating}>Updating…</span>
        ) : (
          <button type="button" className={s.refresh} onClick={() => void refresh()}>
            Refresh
          </button>
        )}
      </footer>

      <svg className={s.flow} aria-hidden="true">
        <defs>
          <linearGradient id="coord-og" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="var(--c-orange)" />
            <stop offset=".45" stopColor="var(--c-orange)" />
            <stop offset="1" stopColor="var(--c-green-2)" />
          </linearGradient>
          <linearGradient id="coord-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--c-green-2)" stopOpacity=".7" />
            <stop offset=".55" stopColor="var(--c-green)" />
            <stop offset="1" stopColor="var(--pill-ok)" />
          </linearGradient>
          <linearGradient id="coord-r" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--rej-line)" />
            <stop offset="1" stopColor="var(--c-red)" />
          </linearGradient>
        </defs>
        <g ref={layer} />
      </svg>
    </div>
  );
}

function FootItem({ ok, text }: { ok: boolean | null; text: string }) {
  return (
    <>
      <div className={s.fSep} />
      <div className={s.fItem} title={text}>
        <i className={ok === false ? s.bad : ok === null ? s.pending : undefined} />
        {text}
      </div>
    </>
  );
}

function tagClass(h: Hold) {
  if (h.status === "partially_captured") return `${s.tag} ${s.tagHeld}`;
  if (h.status === "captured") return `${s.tag} ${s.tagDone}`;
  return s.tag;
}

function HoldCard({ hold: h, needLabel }: { hold: Hold; needLabel: string }) {
  const { name, place } = donorParts(h.donorName, h.donorCountry);
  const a = holdAmounts(h);
  const spentPct = pct(a.spent, a.total);
  const heldPct = pct(a.held, a.total);
  const relPct = pct(a.released, a.total);
  const mid = (from: number, w: number) => `${Math.min(92, Math.max(8, from + w / 2))}%`;
  return (
    <article className={s.card} data-flow={`hold:${h.pledgeId}`}>
      <div className={tagClass(h)}>{holdStatusLabel(h)}</div>
      <div className={s.pname}>
        <Link href={`/pledge/${encodeURIComponent(h.pledgeId)}`}>
          <b>{name}</b>
        </Link>
        {place && ` · ${place}`}
      </div>
      <div className={s.pneed}>{needLabel}</div>
      {h.authorized > 0 ? (
        <>
          <div className={s.amts}>
            <span>
              <b>{money(h.currency, a.total)}</b> <span className={s.w}>pledged</span>
            </span>
            <span className={s.r}>
              <span>
                <b>{money(h.currency, a.spent)}</b> <span className={s.w}>spent</span>
              </span>
              {a.held > 0 || a.released === 0 ? (
                <span>
                  <b>{money(h.currency, a.held)}</b> <span className={s.w}>held</span>
                </span>
              ) : null}
              {a.released > 0 && (
                <span>
                  <b>{money(h.currency, a.released)}</b> <span className={s.w}>released</span>
                </span>
              )}
            </span>
          </div>
          <div className={s.bar} role="img" aria-label={`${money(h.currency, a.spent)} spent, ${money(h.currency, a.held)} held, ${money(h.currency, a.released)} released`}>
            <i className={s.s} style={{ width: `${spentPct}%` }} />
            <i className={s.h} style={{ width: `${heldPct}%` }} />
            <i className={s.x} style={{ width: `${relPct}%` }} />
          </div>
          <div className={s.lbls}>
            {a.spent > 0 && <span className={s.ls}>{money(h.currency, a.spent)}</span>}
            {a.held > 0 && (
              <span className={s.lh} style={{ left: mid(spentPct, heldPct) }}>
                {money(h.currency, a.held)}
              </span>
            )}
            {a.released > 0 && (
              <span className={s.lx} style={{ left: mid(spentPct + heldPct, relPct) }}>
                {money(h.currency, a.released)} released
              </span>
            )}
          </div>
        </>
      ) : (
        <div className={s.waiting}>
          <b>{money(h.currency, h.pledged)}</b> pledged · {h.status === "pending_approval" ? "waiting for the donor to approve in PayPal" : "no hold at PayPal"}
        </div>
      )}
      <div className={s.hold}>
        Hold ID<span className={`mono ${s.id}`}>{h.authorizationId ?? "—"}</span>
      </div>
    </article>
  );
}

function MatchCard({ hold: h, ratio }: { hold: Hold; ratio: DriveView["match"]["ratio"] }) {
  const a = holdAmounts(h);
  return (
    <article className={`${s.card} ${s.kit}`} data-flow={`hold:${h.pledgeId}`}>
      <div className={s.tag}>{holdStatusLabel(h)}</div>
      <div className={s.kname}>{h.donorName}</div>
      <div className={s.ksub}>
        Company match {ratio ? `${ratio.num}:${ratio.den}` : ""}, cap {money(h.currency, a.total)}
      </div>
      <div className={s.kused}>
        <b>{money(h.currency, a.spent)}</b> <span className={s.w}>used</span>
        {a.released > 0 && (
          <>
            {" · "}
            <b>{money(h.currency, a.released)}</b> <span className={s.w}>released</span>
          </>
        )}
      </div>
      <div className={s.kbar} role="img" aria-label={`${money(h.currency, a.spent)} used of ${money(h.currency, a.total)}`}>
        <i style={{ width: `${pct(a.spent, a.total)}%` }} />
        <i style={{ width: `${pct(a.released, a.total)}%` }} />
      </div>
      <div className={s.hold}>
        Hold ID<span className={`mono ${s.id}`}>{h.authorizationId ?? "—"}</span>
      </div>
    </article>
  );
}

function ReceiptBody({
  view,
  receipt: r,
  lines,
  busy,
  errorFor,
  act,
}: {
  view: DriveView;
  receipt: Receipt;
  lines: LineView[];
  busy: string | null;
  errorFor: (name: string) => ApiError | null;
  act: (name: string, path: string, init?: RequestInit & { json?: unknown }) => Promise<void>;
}) {
  const checks = receiptChecks(r);
  const kept = lines.filter((l) => l.state !== "rejected");
  const refused = lines.filter((l) => l.state === "rejected");
  return (
    <>
      <p className={s.msub}>
        Store receipt · <b>{money(r.currency, r.total)}</b>
        {r.merchant && <small style={{ marginLeft: 8, fontSize: "0.8em", opacity: 0.62 }}>{r.merchant}</small>}
        {r.reader.startsWith("recognized:") && <small style={{ marginLeft: 8, fontSize: "0.8em" }}>Recognized as the sample: saved, checked reading</small>}
      </p>
      <div className={s.mbody}>
        <div className={s.receipt} data-flow="receipt">
          {r.image.published && r.image.url ? (
            <Image src={r.image.url} alt={`Receipt photo from ${r.merchant ?? "the store"}, personal data blurred`} fill unoptimized sizes="298px" />
          ) : (
            <div className={s.noImage}>{r.image.note}</div>
          )}
        </div>
        <div className={s.mcol}>
          <div className={s.checks}>
            {checks.map((c, i) => (
              <div key={i} className={`${s.chk} ${c.text.includes("\n") ? s.two : ""} ${c.ok ? "" : s.bad}`}>
                {c.ok ? <Check size={23} color="var(--ok)" /> : c.severity === "block" || c.severity === "flag" ? <Cross size={23} color="var(--no)" /> : <Clock size={23} />}
                <span>{c.text}</span>
              </div>
            ))}
          </div>
          <div className={s.lines}>
            {kept.map((l, i) => (
              <div key={l.line.lineNo} className={`${s.pill} ${l.state === "approved" ? "" : s.wait} ${i === kept.length - 1 ? s.last : ""}`} data-flow={`line:${l.line.lineNo}`} title={l.reason ?? undefined}>
                {l.state === "approved" ? <Check size={25} color="var(--pill-ok)" /> : <Clock size={25} />}
                <span>
                  <b>
                    {lineName(l).title}
                    {l.qty ? ` (${l.qty})` : ""} · {money(r.currency, l.line.amount)}
                  </b>
                  {l.state === "pending" ? " · waiting" : l.state === "review" ? " · needs a decision" : ""}
                  <LineOriginal line={l} />
                </span>
              </div>
            ))}
            {refused.map((l) => (
              <div key={l.line.lineNo} className={s.rej} data-flow={`line:${l.line.lineNo}`}>
                <Cross size={25} color="var(--no)" />
                <div className={s.t}>
                  <span className={s.t1}>
                    {lineName(l).title} · {money(r.currency, l.line.amount)}
                  </span>
                  <span className={s.t2}>{l.reason}</span>
                  <LineOriginal line={l} />
                </div>
              </div>
            ))}
          </div>
          {r.status === "review" && <Decision view={view} receipt={r} lines={lines} busy={busy} error={errorFor("decide")} act={act} />}
        </div>
      </div>
    </>
  );
}

function Decision({
  receipt: r,
  lines,
  busy,
  error,
  act,
}: {
  view: DriveView;
  receipt: Receipt;
  lines: LineView[];
  busy: string | null;
  error: ApiError | null;
  act: (name: string, path: string, init?: RequestInit & { json?: unknown }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [named, setNamed] = useState<number[]>([]);
  const blocked = r.flags.some((f) => f.severity === "block");
  const askable = lines.filter((l) => l.line.verdict === "review" || (l.line.verdict === "eligible" && l.line.ruleCode));
  const decide = (decision: "approve" | "reject") =>
    act("decide", `/api/receipts/${encodeURIComponent(r.id)}/decision`, { json: { decision, reason: reason.trim(), by: "coordinator", ...(decision === "approve" && named.length ? { lineNos: named } : {}) } });
  return (
    <form className={s.decide} onSubmit={(e) => e.preventDefault()}>
      <b>{blocked ? "This receipt cannot be approved" : "Your decision"}</b>
      <span>
        {blocked
          ? "A blocking check failed (see above). Reject it with a reason; no money moves."
          : "No money moves until you decide. Approving releases the lines held for low confidence or a quantity that does not fit."}
      </span>
      {!blocked &&
        askable.map((l) => (
          <label key={l.line.lineNo}>
            <input type="checkbox" checked={named.includes(l.line.lineNo)} onChange={(e) => setNamed((xs) => (e.target.checked ? [...xs, l.line.lineNo] : xs.filter((x) => x !== l.line.lineNo)))} />
            Also approve line {l.line.lineNo}: {lineName(l).title}
            <LineOriginal line={l} />
          </label>
        ))}
      <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason" maxLength={500} />
      <div className={s.acts}>
        <button type="button" className={s.approve} disabled={blocked || !reason.trim() || busy !== null} onClick={() => decide("approve")}>
          {busy === "decide" ? "Saving…" : "Approve"}
        </button>
        <button type="button" className={s.reject} disabled={!reason.trim() || busy !== null} onClick={() => decide("reject")}>
          Reject
        </button>
      </div>
      {error && <p className={s.error} style={{ margin: 0 }}>{error.message}</p>}
    </form>
  );
}

function WhoPays({ view }: { view: DriveView }) {
  const groups = shareGroups(view);
  const base = view.drive.baseCurrency;
  return (
    <div className={`${s.panel} ${s.bWho}`}>
      <h3 className={s.btitle}>Who pays each approved line</h3>
      <p className={s.bsub}>Each approved line is split across donor holds and the company match, then captured from those holds.</p>
      {groups.length === 0 ? (
        <p className={s.empty}>No approved lines yet.</p>
      ) : (
        <div className={s.whoRows}>
          {groups.map((g) => (
            <div className={s.wrow} key={g.needId} title={captureState(g.statuses).label}>
              <span className={s.wi}>
                <NeedIcon needId={g.needId} size={22} />
              </span>
              <span className={s.nm}>{g.need?.displayLabel ?? g.needId}</span>
              <span className={s.eq}>
                <b>{money(base, g.base)}</b> ={" "}
                {[
                  ...g.donors.map((d) => `${donorParts(d.name).name} ${money(base, d.base)}${d.currency !== base ? ` (${money(d.currency, d.amount)})` : ""}`),
                  ...g.match.map((m) => `${m.name} ${money(base, m.base)}`),
                ].join(" + ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function batchSentence(view: DriveView): string {
  const h = view.drive.batch.maxAgeHours;
  const when = h === 24 ? "once a day" : `every ${h} hours`;
  const thresholds = Object.entries(view.drive.batch.thresholdMinor).map(([cur, minor]) => money(cur, minor as number));
  const saved = view.feeSavings.filter((f) => f.savedMinor && f.savedMinor > 0).map((f) => money(f.currency, f.savedMinor));
  return (
    `Shares are recorded at once and captured ${when}${thresholds.length ? ` or as soon as a hold reaches ${thresholds.join(" / ")}` : ""}` +
    (saved.length ? ` — batching has saved ${saved.join(" + ")} in per-capture fees.` : ", one batch per hold — fewer per-capture fees.")
  );
}

function Activity({ view, busy, capture, error }: { view: DriveView; busy: string | null; capture: () => void; error: ApiError | null }) {
  const items = paypalActivity(view)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(-5);
  const accrued = view.holds.some((h) => h.accrued > 0);
  return (
    <div className={`${s.panel} ${s.bPp}`}>
      <h3 className={s.btitle}>PayPal activity</h3>
      <p className={s.bsub}>{batchSentence(view)}</p>
      {view.drive.status === "open" && (
        <button type="button" className={s.ppBtn} disabled={busy !== null} onClick={capture} title={accrued ? "Capture every recorded share now" : "Nothing is waiting; this also checks PayPal for pending captures"}>
          {busy === "capture" ? "Capturing…" : "Capture now"}
        </button>
      )}
      {error && <p className={s.error}>{error.message}</p>}
      <div className={s.acts}>
        {items.map((a) => (
          <div className={s.act} key={a.key}>
            {a.ok === false ? <Cross size={22.5} color="var(--no)" /> : a.ok === null ? <Clock size={22.5} /> : <Check size={22.5} color="var(--ok)" />}
            <span>
              {a.parts.map((p, i) => (
                <span key={i} style={{ margin: 0 }}>
                  {i > 0 && <i>·</i>}
                  {p}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClosePanel({ view, busy, close, error }: { view: DriveView; busy: string | null; close: () => void; error: ApiError | null }) {
  const status = view.drive.status;
  const sub =
    status === "open"
      ? "After closing, any unspent holds will be released automatically."
      : status === "closing"
        ? "Closing: recorded shares are captured first, then each hold’s remainder is released once PayPal confirms."
        : "Closed. Every hold is settled: pledged = spent + released.";
  const label = status === "open" ? "Close drive — release unspent holds" : status === "closing" ? "Check PayPal and release holds" : "Drive closed";
  return (
    <div className={`${s.panel} ${s.bClose}`}>
      <h3 className={s.btitle}>Close drive</h3>
      <p className={s.bsub}>{sub}</p>
      {error && <p className={s.error}>{error.message}</p>}
      <button type="button" className={s.closeBtn} disabled={status === "closed" || busy !== null} onClick={close}>
        {busy === "close" ? "Closing…" : label}
      </button>
    </div>
  );
}

/** Connectors: funding holds into the receipt, the receipt into each line, each line into its need. */
function flows(view: DriveView, r: Receipt | null, lines: LineView[], box: (k: string) => Box | null): Shape[] {
  const rb = r ? box("receipt") : null;
  if (!r || !rb) return [];
  const out: Shape[] = [];
  const dots: Shape[] = [];
  const funding = view.holds.filter((h) => lines.some((l) => l.shares.some((x) => x.pledgeId === h.pledgeId)));
  const donors = funding.filter((h) => h.kind === "donor");
  donors.forEach((h, k) => {
    const c = box(`hold:${h.pledgeId}`);
    if (!c) return;
    const y = rb.top + rb.height * (0.27 + (0.36 * k) / Math.max(1, donors.length - 1));
    out.push({ d: curve(c.right, c.top + 52, rb.left + 2, y), stroke: "url(#coord-og)", width: 6 });
  });
  for (const h of funding.filter((x) => x.kind === "match")) {
    const c = box(`hold:${h.pledgeId}`);
    if (c) out.push({ d: curve(c.right, c.top + 70, rb.left + 2, rb.top + rb.height * 0.83, 0.4), stroke: "var(--c-teal)", width: 6 });
  }
  let i = 0;
  for (const l of lines) {
    const p = box(`line:${l.line.lineNo}`);
    if (!p) continue;
    const cy = p.top + p.height / 2;
    if (l.state === "rejected") {
      out.push({ d: drop(rb.right + 1, Math.max(rb.top + 20, cy - 200), p.left, cy), stroke: "url(#coord-r)", width: 4 });
      dots.push({ x: p.left - 4, y: cy, r: 5.5, fill: "var(--c-red)" });
      continue;
    }
    out.push({ d: drop(rb.right + 1, Math.max(rb.top + 10, cy - 58), p.left, cy), stroke: "url(#coord-g)", width: 4 });
    dots.push({ x: p.left - 4, y: cy, r: 5.5, fill: "var(--pill-ok)" });
    const n = l.state === "approved" && l.need ? box(`need:${l.need.needId}`) : null;
    if (n) {
      out.push({ d: curve(p.right + 1, cy, n.left - 2, n.top + 50), stroke: i++ % 2 ? "var(--c-green)" : "var(--c-green-2)", width: 3.6 });
      dots.push({ x: p.right + 1, y: cy, r: 4.5, fill: "var(--pill-ok)" }, { x: n.left - 2, y: n.top + 50, r: 5, fill: "var(--pill-ok)" });
    }
  }
  return [...out, ...dots];
}

