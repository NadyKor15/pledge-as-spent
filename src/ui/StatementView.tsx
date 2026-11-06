"use client";

import Image from "next/image";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { api, asApiError, useAction, useDrive, type ApiError } from "./api";
import { classes } from "./cls";
import { captureState, holdAmounts, holdTag, reauthorized, returningAtPayPal } from "./derive";
import { day, itemPhrase, lineRange, money, pct, rateText, titleParts } from "./format";
import { driveBadge, MobileHeader, roleHref } from "./Header";
import { Check, Clock, Gift, Info, NeedIcon } from "./icons";
import { Failure, Loading, StaleData } from "./states";
import { StatementActions } from "./statement/Actions";
import type { DriveView, Receipt, Statement, StatementView } from "./types";
import "./statement.css";

const s = classes("st");

/** How long this page keeps re-reading on its own while a void is on its way. */
const RETURN_WATCH_MS = 5 * 60_000;

/** One donor's statement. The drive view fills in what the statement does not carry: store, photo, match, display names. */
export function StatementScreen({ params }: { params: Promise<{ pledgeId: string }> }) {
  const { pledgeId } = use(params);
  const [data, setData] = useState<StatementView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => api<StatementView>(`/api/pledges/${encodeURIComponent(pledgeId)}/statement`), [pledgeId]);
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(asApiError(e));
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load().then(
      (v) => {
        if (live) setData(v);
      },
      (e) => {
        if (live) setError(asApiError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  if (!data) {
    if (!error) return <Loading what="your statement" />;
    return <Failure title={error.status === 404 ? "No such pledge" : "The statement could not be loaded"} message={error.message} />;
  }
  return <WithDrive data={data} reload={reload} />;
}

function WithDrive({ data, reload }: { data: StatementView; reload: () => Promise<void> }) {
  const d = useDrive(data.drive.id);
  const events = d.view?.eventCount;
  useEffect(() => {
    if (events !== undefined) void reload();
  }, [events, reload]);
  if (!d.view) {
    if (!d.error) return <Loading what="your statement" />;
    return <Failure title="The statement could not be loaded" message={d.error.message} />;
  }
  return (
    <>
      <StaleData error={d.error} retry={d.refresh} />
      <Page view={d.view} st={data.statement} data={data} following={d.following} follow={d.follow} refresh={d.refresh} />
    </>
  );
}

interface Bought {
  key: string;
  receipt: Receipt | undefined;
  needId: string;
  phrase: string;
  lineNos: number[];
  share: number;
  shareBase: number;
  matchBase: number;
  statuses: string[];
}

/** The statement's rows grouped into what was bought: one entry per need per receipt. */
function boughtItems(view: DriveView, st: Statement): Bought[] {
  const groups = new Map<string, Bought & { qty: number; unit: string; label: string }>();
  for (const row of st.rows) {
    const key = `${row.receiptId}:${row.needId}`;
    const need = view.needs.find((n) => n.needId === row.needId);
    const g = groups.get(key) ?? {
      key,
      receipt: view.receipts.find((r) => r.id === row.receiptId),
      needId: row.needId,
      phrase: "",
      lineNos: [],
      share: 0,
      shareBase: 0,
      matchBase: 0,
      statuses: [],
      qty: 0,
      unit: row.unit,
      label: need?.displayLabel ?? row.item,
    };
    g.lineNos.push(row.lineNo);
    g.qty += row.qty;
    g.share += row.share.minor;
    g.shareBase += row.shareBase;
    g.matchBase += row.matchBase;
    g.statuses.push(row.status);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, phrase: itemPhrase(g.qty, g.unit, g.label) }));
}

/** "Your €4.58 paid for half of 12 bottles of water 2 L (receipt lines 1–3); Kitasora Logistics matched the other half." */
function answer(view: DriveView, st: Statement, b: Bought): string {
  const base = view.drive.baseCurrency;
  const company = view.match.holds[0]?.donorName;
  const lineTotal = view.ledger.filter((x) => x.receiptId === b.receipt?.id && x.lineNo !== null && b.lineNos.includes(x.lineNo) && (x.kind === "donor_share" || x.kind === "match_share")).reduce((a, x) => a + x.base, 0);
  const half = b.shareBase * 2 === lineTotal && b.matchBase === b.shareBase;
  const lines = `receipt ${b.lineNos.length === 1 ? "line" : "lines"} ${lineRange(b.lineNos)}`;
  const own = `Your ${money(st.currency, b.share)} ${captureState(b.statuses).done ? "paid" : "is paying"} for ${half ? "half" : "part"} of ${b.phrase} (${lines})`;
  if (!company || b.matchBase === 0) return `${own}.`;
  return half ? `${own}; ${company} matched the other half.` : `${own}; ${company} added ${money(base, b.matchBase)}.`;
}

function holdFate(view: DriveView, st: Statement): string {
  const b = st.balance;
  const expires = b.expiresAt ? day(b.expiresAt, false) : null;
  if (returningAtPayPal(b)) return "returning at PayPal";
  if (b.status === "voided") return "returned";
  if (b.status === "captured") return "fully spent";
  if (b.status === "expired") return "expired";
  if (b.status === "denied") return "declined by PayPal";
  if (!expires) return "";
  return reauthorized(view, b.pledgeId) ? `re-authorized, expires ${expires}` : `expires ${expires}`;
}

function Page({ view, st, data, following, follow, refresh }: { view: DriveView; st: Statement; data: StatementView; following: boolean; follow: (ms?: number) => void; refresh: () => Promise<unknown> }) {
  const { head, tail } = titleParts(view.drive.displayTitle);
  const b = st.balance;
  const a = holdAmounts(b);
  const returning = returningAtPayPal(b);
  const watched = useRef(false);
  // A void waits for the hold's capture and for PayPal's word on it: this page re-reads by itself meanwhile, reloaded or not.
  useEffect(() => {
    if (!returning || watched.current) return;
    watched.current = true;
    follow(RETURN_WATCH_MS);
  }, [returning, follow]);
  const items = boughtItems(view, st);
  const receipts = [...new Map(items.flatMap((i) => (i.receipt ? [[i.receipt.id, i.receipt] as const] : []))).values()];
  const ratio = view.match.ratio;
  const help = st.totals.shareBase > 0 ? Math.round((st.totals.share * st.totals.helpBase) / st.totals.shareBase) : 0;
  const fate = holdFate(view, st);
  const live = (b.status === "authorized" || b.status === "partially_captured") && !returning;
  const pending = items.some((i) => !captureState(i.statuses).done);
  const rate = rateText(view.holds.find((h) => h.pledgeId === b.pledgeId)?.fx);
  const parts = [
    { key: "spent", bar: s.bSpent, stat: s.sSpent, value: a.spent, word: "spent", always: true },
    { key: "waiting", bar: s.bWait, stat: s.sWait, value: a.waiting, word: "waiting", always: false },
    { key: "held", bar: s.bHeld, stat: s.sHeld, value: a.held, word: "held", always: live },
    { key: "returning", bar: s.bBack, stat: s.sBack, value: a.returning, word: "Returning at PayPal…", always: false },
    { key: "returned", bar: s.bRel, stat: s.sRel, value: a.released, word: "returned", always: !returning },
  ].filter((p) => p.always || p.value > 0);
  return (
    <div className={s.page}>
      <MobileHeader badge={driveBadge(view.drive.demo)} />

      <section className={s.title}>
        <div className={s.t1}>Your pledge to</div>
        <h1 className={s.t2}>{head}</h1>
        {tail && <div className={s.t3}>{tail}</div>}
      </section>

      <section className={`${s.card} ${s.sum}`} aria-label="Pledge summary">
        <div className={s.sumRow}>
          <span className={s.sumAmt}>{money(st.currency, a.total)}</span>
          <span className={s.sumLbl}>pledged</span>
          {b.revoked && <span className={s.tag}>{holdTag(b)}</span>}
        </div>
        <div className={s.bar} role="img" aria-label={parts.map((p) => `${money(st.currency, p.value)} ${p.word}`).join(", ")}>
          {parts.map((p) => (
            <i key={p.key} className={p.bar} data-part={p.key} style={{ width: `${pct(p.value, a.total)}%` }} />
          ))}
        </div>
        <div className={s.stats}>
          {parts.map((p) => (
            <div key={p.key} className={`${s.stat} ${p.stat}`}>
              <b>{money(st.currency, p.value)}</b>
              <span>{p.word}</span>
            </div>
          ))}
        </div>
      </section>

      {st.totals.uncollected + st.totals.reversed > 0 && (
        <p className={s.note}>
          {st.totals.uncollected > 0 && `${money(st.currency, st.totals.uncollected)} could not be collected from this hold. `}
          {st.totals.reversed > 0 && `${money(st.currency, st.totals.reversed)} was taken back by PayPal after capture.`}
        </p>
      )}

      {st.totals.matchBase > 0 && ratio && (
        <section className={`${s.card} ${s.match}`}>
          <div className={s.gift}>
            <Gift w={18.3} h={21} />
          </div>
          <div className={s.vline} />
          <p>
            With the {ratio.num}:{ratio.den} company match, your <span className={s.nw}>{money(st.currency, st.totals.share)}</span> {pending ? "is becoming" : "became"} <strong className={s.nw}>{money(st.currency, help)} of help.</strong>
          </p>
        </section>
      )}

      <section className={`${s.card} ${s.bought}`}>
        <h2 className={s.h2}>{pending ? "What your money is buying" : "What your money bought"}</h2>
        {items.length === 0 && (
          <p className={s.empty}>
            {returning
              ? `Nothing was bought with this pledge. Your ${money(st.currency, a.returning)} is on its way back at PayPal and was never charged.`
              : a.total > 0 && b.authorized > 0 && a.held === 0
                ? `Nothing was bought with this pledge. Your ${money(st.currency, a.released)} went back at PayPal and was never charged.`
                : `Nothing yet. ${a.total > 0 && b.authorized > 0 ? `Your ${money(st.currency, a.total)} is held at PayPal` : "Your pledge is waiting for approval in PayPal"}: it is charged only when a volunteer’s receipt for this need passes the checks.`}
          </p>
        )}
        {items.map((i) => {
          const cap = captureState(i.statuses);
          return (
            <div className={s.item} key={i.key}>
              <div className={s.drop}>
                <NeedIcon needId={i.needId} size={27.5} />
              </div>
              <div className={s.itemTxt}>
                <div className={s.itemName}>{i.phrase}</div>
                <div className={s.itemMeta}>
                  receipt {i.lineNos.length === 1 ? "line" : "lines"} {lineRange(i.lineNos)}
                  {i.receipt?.merchant && (
                    <>
                      <span className={s.sep}>·</span>
                      <span className={s.ja}>{i.receipt.merchant}</span>
                    </>
                  )}
                  {i.receipt?.purchasedAt && (
                    <>
                      <span className={s.sep}>·</span>
                      <span className={s.date}>{day(i.receipt.purchasedAt)}</span>
                    </>
                  )}
                </div>
                <div className={`${s.cap} ${cap.done ? "" : s.capWait}`}>
                  {cap.done ? <Check size={15.1} color="var(--check)" /> : <Clock size={15.1} />}
                  <span>{cap.label}</span>
                </div>
              </div>
            </div>
          );
        })}

        {receipts.map((r) => (
          <ReceiptFrame key={r.id} receipt={r} firstLine={Math.min(...items.filter((i) => i.receipt?.id === r.id).flatMap((i) => i.lineNos))} />
        ))}

        <div className={s.hr} />
        <div className={s.hold}>
          <Info size={16.4} />
          <p>
            {b.authorizationId ? (
              <span className={s.nw}>
                Hold <span className={`mono ${s.mono}`}>{b.authorizationId}</span>
              </span>
            ) : (
              "No hold at PayPal yet"
            )}
            {fate && (
              <>
                <span className={s.sep}>·</span>
                <span className={s.nw}>{fate}</span>
              </>
            )}
            {live && (
              <>
                <br />
                Whatever is not spent goes back when the drive closes.
              </>
            )}
            {rate && (
              <>
                <br />
                Rate at pledge: {rate}
              </>
            )}
          </p>
        </div>

        {receipts[0]?.image.url && (
          <a className={s.btn} href={receipts[0].image.url} target="_blank" rel="noopener noreferrer">
            See the full receipt
          </a>
        )}
        <Withdraw view={view} st={st} follow={follow} refresh={refresh} />
        {(pending || returning) && !following && (
          <button type="button" className={s.link} onClick={() => void refresh()}>
            Refresh
          </button>
        )}
      </section>

      {items.length > 0 && (
        <section className={`${s.card} ${s.ask}`}>
          <h2 className={s.h2}>In one sentence, from the ledger</h2>
          <div className={s.askRow}>
            <div className={s.bubble}>
              {items.map((i) => (
                <p key={i.key}>{answer(view, st, i)}</p>
              ))}
            </div>
          </div>
        </section>
      )}

      <StatementActions data={data} view={view} />

      <Link className={s.back} href={roleHref(view.drive.id, "donor")}>
        Back to the drive
      </Link>
    </div>
  );
}

/**
 * Two windows on the same photo, as on the reference: this donor's lines and the
 * payment block. There are no line positions in the reading, so the first window
 * follows the line's place in the list across the part of a receipt that holds lines.
 */
function ReceiptFrame({ receipt: r, firstLine }: { receipt: Receipt; firstLine: number }) {
  if (!r.image.published || !r.image.url) return <p className={s.empty}>{r.image.note}</p>;
  const alt = `Receipt photo from ${r.merchant ?? "the store"}, lines from ${firstLine} on and the total; personal data blurred`;
  const along = (firstLine - 1) / Math.max(1, r.lines.length - 1);
  return (
    <>
      <div className={s.frame}>
        <div className={`${s.win} ${s.winA}`}>
          <Image src={r.image.url} alt={alt} width={630} height={1292} unoptimized style={{ transform: `translateY(-${(24.69 + along * 38.5).toFixed(2)}%)` }} />
        </div>
        <div className={`${s.win} ${s.winB}`}>
          <Image src={r.image.url} alt="" width={630} height={1292} unoptimized />
        </div>
      </div>
      <p className={s.caption}>{(r.image.blurredRegions ?? 0) > 0 ? "Published with card digits and member name hidden" : "No personal data was found on this receipt"}</p>
    </>
  );
}

function Withdraw({ view, st, follow, refresh }: { view: DriveView; st: Statement; follow: (ms?: number) => void; refresh: () => Promise<unknown> }) {
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState(false);
  const b = st.balance;
  const live = view.drive.status === "open" && !b.revoked && (b.status === "authorized" || b.status === "partially_captured");
  if (b.revoked) {
    return (
      <p className={s.withdrawn} role="status">
        {returningAtPayPal(b) ? "You withdrew this pledge. What was already bought stays paid; the rest is on its way back at PayPal." : "You withdrew this pledge. What was already bought stays paid; the rest went back at PayPal."}
      </p>
    );
  }
  if (!live) return null;
  if (!asking) {
    return (
      <button type="button" className={s.link} onClick={() => setAsking(true)}>
        Withdraw pledge
      </button>
    );
  }
  const withdraw = async () => {
    const done = await run("withdraw", () => api(`/api/pledges/${encodeURIComponent(b.pledgeId)}/revoke`, { method: "POST" }));
    await refresh();
    if (done !== undefined) follow(RETURN_WATCH_MS);
  };
  return (
    <div className={s.confirm}>
      <p>Withdraw this pledge? What was already bought stays paid. The rest of the hold goes back to you.</p>
      <div className={s.confirmActs}>
        <button type="button" className={s.yes} disabled={busy !== null} onClick={withdraw}>
          {busy ? "Withdrawing…" : "Yes, withdraw"}
        </button>
        <button type="button" className={s.keep} disabled={busy !== null} onClick={() => setAsking(false)}>
          Keep my pledge
        </button>
      </div>
      {error && <p className={s.err}>{error.error.message}</p>}
    </div>
  );
}
