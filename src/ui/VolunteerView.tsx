"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, useAction, type ApiError } from "./api";
import { classes } from "./cls";
import { lineViews, readLabel, receiptChecks, shareGroups } from "./derive";
import { ago, money, ofCount, titleParts } from "./format";
import { driveBadge, roleHref } from "./Header";
import { Check, Clock, Cross, Info, NeedIcon } from "./icons";
import type { DriveView, Receipt } from "./types";
import { prepareUpload } from "./upload";
import "./volunteer.css";

const s = classes("vo");

/** Refusals that the sample receipt gets around: it needs no live reading. */
const LIVE_LIMITS = new Set(["spend_cap", "live_limit", "live_reading_off", "reading_timeout"]);

function uploadErrorText(e: ApiError): string {
  // The platform's own 413 has no JSON body, so its text is not ours.
  return e.code === "http_413" ? "This photo is too large to send. Crop it to the receipt, or use the sample receipt." : e.message;
}

/** The receipt form until there is a receipt to show; after that, the result as on the reference. */
export function VolunteerView({ view, following, refresh, follow }: { view: DriveView; following: boolean; refresh: () => Promise<unknown>; follow: () => void }) {
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState(false);
  const receipt = view.receipts[view.receipts.length - 1] ?? null;
  const path = `/api/drives/${encodeURIComponent(view.drive.id)}/receipts`;

  const send = async (name: string, body: () => Promise<FormData>) => {
    const sent = await run(name, async () => api(path, { method: "POST", body: await body() }));
    await refresh();
    if (sent === undefined) return;
    setAsking(false);
    follow();
  };
  const sample = () =>
    send("sample", async () => {
      const form = new FormData();
      form.set("sample", "hero");
      return form;
    });
  const upload = (file: File) =>
    send("upload", async () => {
      const blob = await prepareUpload(file);
      const form = new FormData();
      form.set("image", blob, blob === file ? file.name : "receipt.jpg");
      form.set("channel", "web");
      return form;
    });

  return (
    <div className={s.page}>
      {asking || !receipt ? (
        <UploadForm view={view} busy={busy} error={error?.error ?? null} upload={upload} sample={sample} back={receipt ? () => setAsking(false) : null} />
      ) : (
        <Result view={view} receipt={receipt} following={following} refresh={refresh} another={() => setAsking(true)} />
      )}
    </div>
  );
}

function DriveHead({ view, lead }: { view: DriveView; lead: string }) {
  const { head, tail } = titleParts(view.drive.displayTitle);
  return (
    <>
      <div className={s.cTitle}>
        {lead} {head}
      </div>
      <div className={s.cSubrow}>
        <div className={s.cSub}>{tail}</div>
        <div className={s.chip}>{driveBadge(view.drive.demo)}</div>
      </div>
    </>
  );
}

function UploadForm({
  view,
  busy,
  error,
  upload,
  sample,
  back,
}: {
  view: DriveView;
  busy: string | null;
  error: ApiError | null;
  upload: (f: File) => void;
  sample: () => void;
  back: (() => void) | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const open = view.drive.status === "open";
  return (
    <>
      <section className={`${s.card} ${s.cAsk}`}>
        <DriveHead view={view} lead="Receipt for" />
        <p className={s.askText}>Photograph the whole receipt. AI reads every line and checks it against the needs below: approved lines are paid back to you through PayPal, and each other line is refused with a reason.</p>
        <div className={s.appr}>
          {view.needs.map((n) => (
            <div className={s.need} key={n.needId}>
              <span className={s.ic}>
                <NeedIcon needId={n.needId} size={17} />
              </span>
              <span className={s.nm}>{n.displayLabel}</span>
              <span className={s.amt}>{ofCount(n.qtyCovered, n.qtyNeeded, n.unit)}</span>
            </div>
          ))}
        </div>
      </section>
      {error && (
        <section className={`${s.card} ${s.cErr}`} role="alert">
          <Cross size={18} color="var(--rej-icon)" />
          <div>
            <p>{uploadErrorText(error)}</p>
            {LIVE_LIMITS.has(error.code) && <p className={s.errHint}>The sample receipt needs no live reading and goes through the same checks and the same PayPal steps.</p>}
          </div>
        </section>
      )}
      {!open && <p className={s.closedNote}>The drive is {view.drive.status}; it takes no new receipts.</p>}
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/*"
        aria-label="Receipt photo"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload(f);
        }}
      />
      <button type="button" className={`${s.btn} ${s.primary}`} disabled={!open || busy !== null} onClick={() => input.current?.click()}>
        {busy === "upload" ? "Reading your receipt…" : "Upload a receipt photo"}
      </button>
      <button type="button" className={`${s.btn} ${s.secondary}`} disabled={!open || busy !== null} onClick={sample}>
        {busy === "sample" ? "Reading the sample receipt…" : "Use the sample receipt"}
      </button>
      {back && (
        <button type="button" className={s.link} disabled={busy !== null} onClick={back}>
          Back to the last receipt
        </button>
      )}
    </>
  );
}

function Payout({ view, receipt: r, following, refresh }: { view: DriveView; receipt: Receipt; following: boolean; refresh: () => Promise<unknown> }) {
  const base = view.drive.baseCurrency;
  const a = view.payouts.find((p) => p.receiptId === r.id)?.attempts.at(-1);
  const who = view.drive.volunteerName ? `Volunteer ${view.drive.volunteerName}` : "The volunteer";
  if (!a) {
    if (r.status === "review") return <Status icon={<Clock size={36} />} head="With the coordinator" sub="No money moves until they decide" meta="You will see the result here" />;
    if (r.status === "rejected") return <Status icon={<Cross size={36} color="var(--rej-icon)" />} head="Receipt rejected" sub="Nothing was paid" meta={(r.decision as { reason?: string } | null)?.reason ?? ""} />;
    return <Status icon={<Cross size={36} color="var(--rej-icon)" />} head="Nothing to pay" sub="No line on this receipt was approved" meta="" />;
  }
  if (a.status === "failed") return <Status icon={<Cross size={36} color="var(--rej-icon)" />} head="The payout did not go through" sub={`PayPal Payouts · FAILED · ${money(base, a.amount)}`} meta={a.failReason ?? ""} />;
  const done = a.status === "confirmed";
  return (
    <Status
      icon={done ? <Check size={37.5} color="var(--pay-icon)" /> : <Clock size={36} />}
      head={`${money(base, a.amount)} ${done ? "sent to your PayPal" : "on its way to your PayPal"}`}
      sub={
        <>
          <span>PayPal Payouts</span>
          <span className={s.dot}>·</span>
          <span className={s.st}>{done ? "SUCCESS" : "PENDING"}</span>
          <span className={s.dot}>·</span>
          <span className={s.when}>{ago(a.submittedAt)}</span>
        </>
      }
      meta={done ? `${who} reimbursed` : `For ${who.replace(/^The /, "the ")}`}
      refresh={done || following ? undefined : refresh}
    />
  );
}

function Status({ icon, head, sub, meta, refresh }: { icon: React.ReactNode; head: string; sub: React.ReactNode; meta: string; refresh?: () => Promise<unknown> }) {
  return (
    <section className={`${s.card} ${s.cPay}`}>
      <div className={s.pay}>
        <span className={s.payIcon}>{icon}</span>
        <div className={s.tx}>
          <div className={s.h}>{head}</div>
          <div className={s.s}>{sub}</div>
          {meta && <div className={s.m}>{meta}</div>}
          {refresh && (
            <button type="button" className={s.refresh} onClick={() => void refresh()}>
              Refresh
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Result({ view, receipt: r, following, refresh, another }: { view: DriveView; receipt: Receipt; following: boolean; refresh: () => Promise<unknown>; another: () => void }) {
  const base = view.drive.baseCurrency;
  const lines = lineViews(view, r);
  const approved = lines.filter((l) => l.state === "approved");
  const refused = lines.filter((l) => l.state === "rejected");
  const waiting = lines.filter((l) => l.state === "pending" || l.state === "review");
  const groups = shareGroups(view, r.id);
  const hours = view.drive.batch.maxAgeHours;
  return (
    <>
      <section className={`${s.card} ${s.cReceipt}`}>
        <DriveHead view={view} lead="Receipt for" />
        <div className={s.cBody}>
          <div className={s.photo}>
            {r.image.published && r.image.url ? (
              <Image src={r.image.url} alt={`Receipt from ${r.merchant ?? "the store"}, personal data blurred`} fill unoptimized sizes="164px" />
            ) : (
              <div className={s.noImage}>{r.image.note}</div>
            )}
          </div>
          <div className={s.rCol}>
            <div className={s.store}>{r.merchant ?? "Unknown store"}</div>
            <div className={s.total}>{money(r.currency, r.total)}</div>
            <div className={s.lines}>
              {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}
            </div>
            <div className={`${s.chk} ${s.read}`}>
              <Check size={16} color="var(--chk-icon)" />
              <span>{readLabel(r)}</span>
            </div>
            <div className={s.checks}>
              {receiptChecks(r).map((c, i) => (
                <div key={i} className={`${s.chk} ${c.text.includes("\n") ? s.two : ""} ${c.ok ? "" : s.bad}`}>
                  {c.ok ? <Check size={16} color="var(--chk-icon)" /> : c.severity === "review" ? <Clock size={16} /> : <Cross size={16} color="var(--rej-icon)" />}
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`${s.card} ${s.cLines}`}>
        <div className={s.verdict}>
          {r.status === "review" ? (
            <span className={s.wait}>Waiting for the coordinator</span>
          ) : (
            <span className={s.ok}>
              {approved.length} {approved.length === 1 ? "line" : "lines"} approved
            </span>
          )}
          {refused.length > 0 && (
            <>
              <span className={s.dot}>·</span>
              <span className={s.no}>{refused.length} rejected</span>
            </>
          )}
        </div>
        {groups.length > 0 && (
          <div className={s.appr}>
            {groups.map((g) => (
              <div className={s.need} key={g.needId}>
                <span className={s.ic}>
                  <NeedIcon needId={g.needId} size={17} />
                </span>
                <span className={s.nm}>{g.need?.displayLabel ?? g.needId}</span>
                <span className={s.amt}>{money(base, g.base)}</span>
              </div>
            ))}
          </div>
        )}
        {waiting.length > 0 && (
          <p className={s.waitNote}>
            {waiting.length} {waiting.length === 1 ? "line waits" : "lines wait"} for the coordinator’s decision.
          </p>
        )}
        {refused.map((l) => (
          <div className={s.rej} key={l.line.lineNo}>
            <Cross size={17.6} color="var(--rej-icon)" />
            <div className={s.rejTx}>
              <div className={s.t}>
                {l.line.text}
                <span className={s.dot}>·</span>
                <span className={s.pr}>{money(r.currency, l.line.amount)}</span>
              </div>
              <div className={s.why}>{l.reason}</div>
            </div>
          </div>
        ))}
      </section>

      <Payout view={view} receipt={r} following={following} refresh={refresh} />

      <section className={`${s.card} ${s.cInfo}`}>
        <Info size={19.6} outline />
        <p>Approved lines are paid from the donors’ holds {hours === 24 ? "once a day" : `every ${hours} hours`} — your reimbursement does not wait for that.</p>
      </section>

      <button type="button" className={`${s.btn} ${s.primary}`} onClick={another}>
        Upload another receipt
      </button>
      <Link className={`${s.btn} ${s.secondary}`} href={roleHref(view.drive.id, "coordinator")}>
        See who paid for each line
      </Link>
    </>
  );
}
