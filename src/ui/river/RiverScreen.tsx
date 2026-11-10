"use client";

import { useSearchParams } from "next/navigation";
import { use, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useDrive } from "../api";
import { classes } from "../cls";
import { moneyIn, type Lang } from "../format";
import { driveTitleIn, HEADER_WORDS } from "../header-words";
import { LANG_TAG, parseLang } from "../ledger/i18n";
import { Failure, Loading } from "../states";
import type { DriveView } from "../types";
import { riverModel, type RiverHold, type RiverModel, type RiverNeed } from "./model";
import { RIVER_WORDS, type RiverWords, type Step } from "./words";
import "./river.css";

// П2, the river of money (variant A, Nadya TG 6886): one receipt followed from the store to PayPal in seven steps, the
// ribbons as thick as the money they carry in the drive's currency. Built by the chosen picture
// (docs/nadya/kindtrail-2026-11-09/u2/ui-2026-11-10-river/img/A-flow.png); the figures are riverModel's, which adds up
// to the Ledger (tests/app/river-model.test.ts). A desktop reads it left to right; a phone top to bottom.

const s = classes("rv");

/** The playback: seven steps over 20 seconds, one column after another. */
export const DURATION_MS = 20_000;
export const STEPS = 7;

const k = (step: number) => ({ "--k": step }) as CSSProperties;

/** PayPal's own words for a payout's and a hold's state, as PayPal prints them (never translated). */
export const payoutStatus = (status: string): string => (status === "confirmed" ? "SUCCESS" : status === "pending" || status === "sent" ? "PENDING" : status.toUpperCase());
export const holdStatus = (status: string): string => status.toUpperCase();

/** "0:12 / 0:20". */
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} / ${Math.floor(DURATION_MS / 60_000)}:${String((DURATION_MS / 1000) % 60).padStart(2, "0")}`;

export function RiverScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const d = useDrive(id);
  if (!d.view) {
    if (!d.error) return <Loading what="the river of money" />;
    return <Failure title={d.error.status === 404 ? "No such drive" : "The river of money could not be loaded"} message={d.error.message} />;
  }
  return <River view={d.view} />;
}

/** Below this width the river runs top to bottom. */
const PHONE_QUERY = "(max-width: 1179px)";
const subscribeMedia = (query: string) => (cb: () => void) => {
  const mq = window.matchMedia(query);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const subscribePhone = subscribeMedia(PHONE_QUERY);
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;
const notPhone = () => false;

function River({ view }: { view: DriveView }) {
  const lang = parseLang(useSearchParams().get("lang"));
  const w = RIVER_WORDS[lang];
  const m = useMemo(() => riverModel(view, lang), [view, lang]);
  const phone = useSyncExternalStore(subscribePhone, isPhone, notPhone);
  const bar = useRef<HTMLSpanElement>(null);
  const play = usePlayback(bar);
  const title = driveTitleIn(lang, view.drive.displayTitle);
  const book = `/drive/${encodeURIComponent(view.drive.id)}?as=ledger${lang === "en" ? "" : `&lang=${lang}`}`;

  return (
    <div className={s.root} lang={LANG_TAG[lang]} data-step={play.step} data-reset={play.reset ? "" : undefined} data-layout={phone ? "phone" : "desktop"} style={{ "--step": play.step } as CSSProperties} data-testid="river">
      <header className={s.top}>
        <a className={s.brand} href={book}>
          Pledge-as-Spent
        </a>
        <h1 className={s.title}>{title}</h1>
        <span className={s.badge}>{HEADER_WORDS[lang].badge(view.drive.demo)}</span>
        <div className={s.play}>
          <span className={s.track} role="progressbar" aria-label={w.playback} aria-valuemin={0} aria-valuemax={DURATION_MS / 1000} aria-valuenow={play.sec}>
            <span ref={bar} className={s.fill} data-testid="river-bar" />
          </span>
          <span className={s.clock} data-testid="river-clock">
            {clock(play.sec)}
          </span>
          <button type="button" className={s.replay} onClick={play.replay} data-testid="river-replay">
            {w.replay}
          </button>
        </div>
      </header>

      {!m.receipt ? (
        <p className={s.none}>{w.nothingYet}</p>
      ) : phone ? (
        <PhoneRiver m={m} w={w} />
      ) : (
        <DesktopRiver m={m} w={w} />
      )}

      {m.receipt && <Sums m={m} w={w} lang={lang} />}
      <p className={s.end}>
        <span>
          {w.traced(m.baseCurrency)} {m.closed ? w.closedTail : w.openTail}
        </span>
      </p>
    </div>
  );
}

/** Seven steps over 20 s; Replay starts again; with reduced motion everything is shown at once and the bar is full. */
function usePlayback(bar: RefObject<HTMLSpanElement | null>) {
  const [run, setRun] = useState(0);
  const [st, setSt] = useState({ step: 0, sec: 0, reset: true });
  useEffect(() => {
    const setBar = (p: number) => {
      if (bar.current) bar.current.style.width = `${(p * 100).toFixed(2)}%`;
    };
    let raf = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      raf = requestAnimationFrame(() => {
        setSt({ step: STEPS, sec: DURATION_MS / 1000, reset: true });
        setBar(1);
      });
      return () => cancelAnimationFrame(raf);
    }
    // First everything hidden at once (no transitions), then the steps one after another.
    let t0 = 0;
    const tick = (now: number) => {
      if (!t0) t0 = now;
      const el = Math.min(DURATION_MS, now - t0);
      const step = Math.min(STEPS, 1 + Math.floor(el / (DURATION_MS / STEPS)));
      const sec = Math.floor(el / 1000);
      setSt((x) => (x.step === step && x.sec === sec && !x.reset ? x : { step, sec, reset: false }));
      setBar(el / DURATION_MS);
      if (el < DURATION_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(() => {
      setSt({ step: 0, sec: 0, reset: true });
      setBar(0);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(tick);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [run, bar]);
  return { ...st, replay: () => setRun((r) => r + 1) };
}

// ── The ribbons ──────────────────────────────────────────────────────────────────────────────────────────────────

type Kind = "trunk" | "flow" | "match" | "refused" | "never";
interface Link {
  id: string;
  from: string;
  /** null: a refused line's short stub that flows nowhere. */
  to: string | null;
  /** Amount in the drive's currency: the ribbon's thickness. */
  base: number;
  kind: Kind;
  step: number;
  dir: "x" | "y";
}

const shareNode = (needId: string, pledgeId: string) => `share:${needId}:${pledgeId}`;

/** The ribbons of one receipt: every amount from the receipt to the payout, the refused lines' stubs, the rests. */
export function riverLinks(m: RiverModel, dir: "x" | "y"): Link[] {
  if (!m.receipt) return [];
  const out: Link[] = [{ id: "trunk", from: "receipt", to: "read", base: m.totals.sharesBase + m.totals.refusedBase, kind: "trunk", step: 2, dir }];
  for (const n of m.needs) {
    out.push({ id: `rn:${n.needId}`, from: "read", to: `need:${n.needId}`, base: n.base, kind: "flow", step: 3, dir });
    for (const sh of n.shares) {
      const kind = sh.kind === "match" ? "match" : "flow";
      out.push({ id: `ns:${n.needId}:${sh.pledgeId}`, from: `need:${n.needId}`, to: shareNode(n.needId, sh.pledgeId), base: sh.base, kind, step: 4, dir });
      out.push({ id: `sh:${n.needId}:${sh.pledgeId}`, from: shareNode(n.needId, sh.pledgeId), to: `hold:${sh.pledgeId}`, base: sh.base, kind, step: 5, dir });
    }
  }
  for (const r of m.refused) {
    out.push({ id: `rr:${r.lineNo}`, from: "read", to: `ref:${r.lineNo}`, base: r.base, kind: "refused", step: 3, dir });
    out.push({ id: `stub:${r.lineNo}`, from: `ref:${r.lineNo}`, to: null, base: r.base, kind: "refused", step: 3, dir });
  }
  if (m.payout)
    for (const h of m.holds)
      if (h.capturedBase > 0) out.push({ id: `cp:${h.pledgeId}`, from: `cap:${h.pledgeId}`, to: "payout", base: h.capturedBase, kind: h.kind === "match" ? "match" : "flow", step: 6, dir });
  for (const n of m.never) out.push({ id: `nv:${n.pledgeId}`, from: `hold:${n.pledgeId}`, to: `never:${n.pledgeId}`, base: n.base, kind: "never", step: 7, dir: "y" });
  return out;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Drawn {
  id: string;
  d: string;
  kind: Kind;
  step: number;
  dir: "x" | "y";
  stub: boolean;
  arrow: string | null;
}

const STUB = { x: 34, y: 22 };
const ARROW = 9;

/** Sankey links between the cards as laid out: ribbons leaving one edge are stacked in the order of where they go. */
export function drawRibbons(links: Link[], boxes: Map<string, Box>, perUnit: number): Drawn[] {
  const th = (l: Link) => Math.max(2, l.base * perUnit);
  const outSide = (l: Link) => (l.dir === "x" ? "r" : "b");
  const inSide = (l: Link) => (l.dir === "x" ? "l" : "t");
  const live = links.filter((l) => boxes.has(l.from) && (l.to === null || boxes.has(l.to)));
  const ports = new Map<string, { node: string; side: string; ends: { l: Link; end: "from" | "to" }[] }>();
  const add = (node: string, side: string, l: Link, end: "from" | "to") => {
    const key = `${node}|${side}`;
    if (!ports.has(key)) ports.set(key, { node, side, ends: [] });
    ports.get(key)!.ends.push({ l, end });
  };
  for (const l of live) {
    add(l.from, outSide(l), l, "from");
    if (l.to) add(l.to, inSide(l), l, "to");
  }
  const at = new Map<string, number>();
  for (const { node, side, ends } of ports.values()) {
    const b = boxes.get(node)!;
    const vertical = side === "l" || side === "r";
    const mid = (x: Box) => (vertical ? x.y + x.h / 2 : x.x + x.w / 2);
    const other = (e: { l: Link; end: "from" | "to" }) => {
      const o = e.end === "from" ? e.l.to : e.l.from;
      return o ? boxes.get(o)! : b;
    };
    ends.sort((a, c) => mid(other(a)) - mid(other(c)));
    let p = mid(b) - ends.reduce((a, e) => a + th(e.l), 0) / 2;
    for (const e of ends) {
      at.set(`${e.l.id}|${e.end}`, p);
      p += th(e.l);
    }
  }
  const f = (n: number) => n.toFixed(1);
  return live.map((l) => {
    const a = boxes.get(l.from)!;
    const t = th(l);
    const p0 = at.get(`${l.id}|from`)!;
    if (!l.to) {
      const d =
        l.dir === "x"
          ? `M${f(a.x + a.w)} ${f(p0)}h${STUB.x}v${f(t)}h${-STUB.x}Z`
          : `M${f(p0)} ${f(a.y + a.h)}h${f(t)}v${STUB.y}h${f(-t)}Z`;
      return { id: l.id, d, kind: l.kind, step: l.step, dir: l.dir, stub: true, arrow: null };
    }
    const b = boxes.get(l.to)!;
    const p1 = at.get(`${l.id}|to`)!;
    if (l.dir === "x") {
      const x0 = a.x + a.w;
      const x1 = b.x;
      const xm = (x0 + x1) / 2;
      const d = `M${f(x0)} ${f(p0)}C${f(xm)} ${f(p0)} ${f(xm)} ${f(p1)} ${f(x1)} ${f(p1)}L${f(x1)} ${f(p1 + t)}C${f(xm)} ${f(p1 + t)} ${f(xm)} ${f(p0 + t)} ${f(x0)} ${f(p0 + t)}Z`;
      return { id: l.id, d, kind: l.kind, step: l.step, dir: l.dir, stub: false, arrow: null };
    }
    const arrow = l.kind === "never";
    const y0 = a.y + a.h;
    const y1 = b.y - (arrow ? ARROW : 0);
    const ym = (y0 + y1) / 2;
    const d = `M${f(p0)} ${f(y0)}C${f(p0)} ${f(ym)} ${f(p1)} ${f(ym)} ${f(p1)} ${f(y1)}L${f(p1 + t)} ${f(y1)}C${f(p1 + t)} ${f(ym)} ${f(p0 + t)} ${f(ym)} ${f(p0 + t)} ${f(y0)}Z`;
    const head = arrow ? `M${f(p1 - 4)} ${f(y1)}L${f(p1 + t + 4)} ${f(y1)}L${f(p1 + t / 2)} ${f(b.y)}Z` : null;
    return { id: l.id, d, kind: l.kind, step: l.step, dir: l.dir, stub: false, arrow: head };
  });
}

/** Measures the cards ([data-node]) inside `ref` and draws the ribbons between them; again on any resize. */
function useRibbons(ref: RefObject<HTMLDivElement | null>, links: Link[], widest: number) {
  const [g, setG] = useState<{ w: number; h: number; ribbons: Drawn[] }>({ w: 0, h: 0, ribbons: [] });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      const r0 = root.getBoundingClientRect();
      const boxes = new Map<string, Box>();
      root.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => {
        const r = el.getBoundingClientRect();
        boxes.set(el.dataset.node as string, { x: r.left - r0.left, y: r.top - r0.top, w: r.width, h: r.height });
      });
      const flow = links.find((l) => l.id === "trunk")?.base ?? 1;
      setG({ w: r0.width, h: r0.height, ribbons: drawRibbons(links, boxes, widest / Math.max(1, flow)) });
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(later);
    ro.observe(root);
    root.querySelectorAll("[data-node]").forEach((el) => ro.observe(el));
    void document.fonts?.ready.then(later);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, links, widest]);
  return g;
}

function Ribbons({ g }: { g: { w: number; h: number; ribbons: Drawn[] } }) {
  return (
    <svg className={s.svg} width={g.w} height={g.h} viewBox={`0 0 ${g.w || 1} ${g.h || 1}`} aria-hidden="true" data-testid="river-ribbons">
      <defs>
        <linearGradient id="rv-stub-x" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#F2A7AE" stopOpacity="0.95" />
          <stop offset="1" stopColor="#F2A7AE" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rv-stub-y" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#F2A7AE" stopOpacity="0.95" />
          <stop offset="1" stopColor="#F2A7AE" stopOpacity="0" />
        </linearGradient>
      </defs>
      {g.ribbons.map((r) => (
        <g key={r.id} className={`${s.rib} ${r.dir === "x" ? s.ribx : s.riby}`} style={k(r.step)} data-ribbon={r.id} data-kind={r.kind}>
          {/* A stub's fill is its fading gradient: no class, so no stylesheet fill overrides it. */}
          <path className={r.stub ? undefined : s[`fill-${r.kind}`]} d={r.d} fill={r.stub ? `url(#rv-stub-${r.dir})` : undefined} />
          {r.arrow && <path className={s.arrowHead} d={r.arrow} />}
        </g>
      ))}
    </svg>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────────────────────────────────────────

function StepHead({ n, step }: { n: number; step: Step }) {
  return (
    <div className={s.head} style={k(n)} data-head={n}>
      <p className={s.headTitle}>
        <span className={s.num}>{n}</span>
        <span>{step.title}</span>
      </p>
      <p className={s.note}>{step.note}</p>
    </div>
  );
}

function steps(m: RiverModel, w: RiverWords): Step[] {
  const match = m.needs.some((n) => n.shares.some((x) => x.kind === "match"));
  return [w.receipt, m.twoReadings ? w.twoReadings : w.oneReading, w.lines, match ? w.shares : w.sharesNoMatch, w.holds, w.payout, w.never];
}

function StoreIcon() {
  return (
    <svg className={s.store} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 13v13h22V13M3.5 8.5 6 4h20l2.5 4.5v2a3.5 3.5 0 0 1-6.25 2.2 3.5 3.5 0 0 1-6.25 0 3.5 3.5 0 0 1-6.25 0A3.5 3.5 0 0 1 3.5 10.5v-2ZM13 26v-7h6v7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function Receipt({ m, w }: { m: RiverModel; w: RiverWords }) {
  const r = m.receipt!;
  return (
    <div className={`${s.card} ${s.receipt}`} data-node="receipt" data-step={1} style={k(1)} data-card="receipt">
      <StoreIcon />
      <p className={s.merchant}>{r.merchant ?? "—"}</p>
      <p className={s.big} data-money="receipt">
        {r.totalText || "—"}
      </p>
      <p className={s.sub}>{w.lineCount(r.lines)}</p>
    </div>
  );
}

function Readings({ m, w }: { m: RiverModel; w: RiverWords }) {
  return (
    <div className={s.read} data-step={2} style={k(2)}>
      {m.twoReadings && (
        <div className={s.pills}>
          <span className={s.pill}>{w.readingA}</span>
          <span className={s.pill}>{w.readingB}</span>
        </div>
      )}
      <div className={`${s.card} ${s.agree}`} data-node="read" data-card="read">
        <svg className={s.check} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="11" />
          <path d="m7 12.5 3.2 3.2L17.2 8.6" />
        </svg>
        <span>{m.twoReadings ? w.agree : w.linesRead(m.receipt!.lines)}</span>
      </div>
    </div>
  );
}

function NeedCard({ n, w }: { n: RiverNeed; w: RiverWords }) {
  return (
    <div className={`${s.card} ${s.need}`} data-node={`need:${n.needId}`} data-step={3} style={k(3)} data-card="need">
      <b>{n.label}</b>
      <span className={s.dot}> · </span>
      <span className={s.lines}>{w.lineNos(n.lineNos)}</span>
    </div>
  );
}

function RefusedCard({ r, w }: { r: RiverModel["refused"][number]; w: RiverWords }) {
  return (
    <div className={`${s.card} ${s.refused}`} data-node={`ref:${r.lineNo}`} data-step={3} style={k(3)} data-card="refused">
      <span>
        {w.line(r.lineNo)} {r.item} <span className={s.nowrap}>{r.text}</span> · {w.refused}
      </span>
      <svg className={s.minus} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" />
        <path d="M5.5 10h9" />
      </svg>
    </div>
  );
}

function ShareCard({ n, sh, w }: { n: RiverNeed; sh: RiverNeed["shares"][number]; w: RiverWords }) {
  const [name, ...place] = sh.who.split(" · ");
  return (
    <div className={`${s.card} ${s.share} ${sh.kind === "match" ? s.shareMatch : ""}`} data-node={shareNode(n.needId, sh.pledgeId)} data-step={4} style={k(4)} data-card="share" data-kind={sh.kind}>
      {sh.kind === "match" ? (
        <>
          <span className={s.who}>{sh.who}</span>
          <span>
            {w.match} <b className={s.nowrap} data-money="share">{sh.text}</b>
          </span>
        </>
      ) : (
        <>
          <span className={s.who}>
            <b>{name}</b>
            {place.length > 0 && ` · ${place.join(" · ")}`}
          </span>
          <b className={`${s.amt} ${s.nowrap}`} data-money="share">
            {sh.text}
          </b>
        </>
      )}
    </div>
  );
}

function HoldCapture({ h, w }: { h: RiverHold; w: RiverWords }) {
  return (
    <div className={s.hc} data-hc={h.kind}>
      <div className={`${s.card} ${s.hold}`} data-node={`hold:${h.pledgeId}`} data-step={5} style={k(5)} data-card="hold">
        <b>{w.hold}</b>
        {h.kind === "match" && <span className={s.whoSmall}>{h.who}</span>}
        <span className={s.id} data-paypal-id>
          {h.authorizationId ?? "—"}
        </span>
        <b className={`${s.amt} ${s.nowrap}`}>{h.authorizedText}</b>
      </div>
      <span className={s.arrow} data-step={5} style={k(5)} aria-hidden="true">
        →
      </span>
      <div className={`${s.card} ${s.capture}`} data-node={`cap:${h.pledgeId}`} data-step={5} style={k(5)} data-card="capture">
        <span className={s.capHead}>
          <b>{w.capture}</b>
          <span className={s.nowrap} data-money="capture" data-kind={h.kind}>
            {h.capturedText}
          </span>
        </span>
        {h.captureIds.length > 0 ? (
          h.captureIds.map((c) => (
            <span key={c} className={s.id} data-paypal-id>
              {c}
            </span>
          ))
        ) : (
          <span className={s.muted}>{w.noCaptureId}</span>
        )}
      </div>
    </div>
  );
}

function Payout({ m, w }: { m: RiverModel; w: RiverWords }) {
  const p = m.payout;
  return (
    <div className={`${s.card} ${s.payout}`} data-node="payout" data-step={6} style={k(6)} data-card="payout">
      <b className={s.payTitle}>{w.payoutTitle}</b>
      {p ? (
        <>
          <span className={`${s.id} ${s.batch}`} data-paypal-id>
            {p.batchId ?? "—"}
          </span>
          <span className={s.to}>{p.to ?? "—"}</span>
          <b className={`${s.big} ${s.nowrap}`} data-money="payout">
            {p.text}
          </b>
          <span className={s.success}>{payoutStatus(p.status)}</span>
        </>
      ) : (
        <span className={s.muted}>—</span>
      )}
    </div>
  );
}

function Never({ m, w }: { m: RiverModel; w: RiverWords }) {
  if (m.never.length === 0)
    return (
      <div className={`${s.card} ${s.never} ${s.open}`} data-step={7} style={k(7)} data-card="never-open">
        <b>{w.stillHeld}</b>
        <span>{w.stillHeldNote}</span>
      </div>
    );
  return (
    <>
      {m.never.map((n) => (
        <div key={n.pledgeId} className={`${s.card} ${s.never}`} data-node={`never:${n.pledgeId}`} data-step={7} style={k(7)} data-card="never">
          <b className={s.neverAmt}>{w.neverCharged(n.text)}</b>
          <span>
            {w.released} · <span className={s.nowrap}>{holdStatus(n.status)}</span>
          </span>
        </div>
      ))}
    </>
  );
}

function Sums({ m, w, lang }: { m: RiverModel; w: RiverWords; lang: Lang }) {
  const c = m.baseCurrency;
  const match = m.totals.matchBase > 0;
  const part = (key: string, label: string, minor: number): ReactNode => (
    <span key={key} className={s.sum} data-sum={key}>
      {label} <b className={s.nowrap}>{moneyIn(lang, c, minor)}</b>
    </span>
  );
  return (
    <p className={s.sums} data-testid="river-sums">
      {part("spent", w.sums.spent, m.totals.donorBase)}
      {match && part("match", w.sums.match, m.totals.matchBase)}
      {part("paid", w.sums.paid, m.totals.payoutBase)}
      {m.closed && part("never", w.sums.never, m.totals.neverBase)}
    </p>
  );
}

// ── The two layouts ──────────────────────────────────────────────────────────────────────────────────────────────

/** Donor holds in the order of the needs they pay for; the match's hold last. */
const orderedHolds = (m: RiverModel) => {
  const first = (h: RiverHold) => m.needs.findIndex((n) => n.shares.some((x) => x.pledgeId === h.pledgeId));
  return m.holds.filter((h) => h.kind === "donor").sort((a, b) => first(a) - first(b));
};

function DesktopRiver({ m, w }: { m: RiverModel; w: RiverWords }) {
  const ref = useRef<HTMLDivElement>(null);
  const links = useMemo(() => riverLinks(m, "x"), [m]);
  const g = useRibbons(ref, links, 80);
  const heads = steps(m, w);
  const n = Math.max(1, m.needs.length);
  const match = m.holds.find((h) => h.kind === "match");
  const r = Math.max(m.refused.length, match ? 1 : 0, 1);
  const first = 2;
  const afterNeeds = first + n;
  const afterRefused = afterNeeds + r;
  const rows = `auto repeat(${n}, auto) repeat(${r}, auto) auto`;
  const at = (col: string, row: string): CSSProperties => ({ gridColumn: col, gridRow: row });
  return (
    <div className={s.desk} ref={ref} style={{ gridTemplateRows: rows }}>
      {heads.map((h, i) => (
        <div key={`p${i}`} className={s.panel} style={at(String(i + 1), "1 / -1")} />
      ))}
      {heads.map((h, i) => (
        <div key={`h${i}`} className={s.headCell} style={at(String(i + 1), "1")}>
          <StepHead n={i + 1} step={h} />
        </div>
      ))}
      <Ribbons g={g} />
      <div className={s.cell} style={at("1", `${first} / ${afterRefused}`)} data-col="1">
        <Receipt m={m} w={w} />
      </div>
      <div className={`${s.cell} ${s.c2}`} style={at("2", `${first} / ${afterRefused}`)} data-col="2">
        <Readings m={m} w={w} />
      </div>
      {m.needs.map((x, i) => (
        <div key={x.needId} className={`${s.cell} ${s.c3}`} style={at("3", String(first + i))} data-col="3">
          <NeedCard n={x} w={w} />
        </div>
      ))}
      {m.refused.map((x, i) => (
        <div key={x.lineNo} className={`${s.cell} ${s.c3}`} style={at("3", String(afterNeeds + i))} data-col="3">
          <RefusedCard r={x} w={w} />
        </div>
      ))}
      {m.needs.map((x, i) => (
        <div key={x.needId} className={`${s.cell} ${s.c4}`} style={at("4", String(first + i))} data-col="4">
          {x.shares.map((sh) => (
            <ShareCard key={sh.pledgeId} n={x} sh={sh} w={w} />
          ))}
        </div>
      ))}
      <div className={`${s.cell} ${s.c5}`} style={at("5", `${first} / ${afterNeeds}`)} data-col="5">
        {orderedHolds(m).map((h) => (
          <HoldCapture key={h.pledgeId} h={h} w={w} />
        ))}
      </div>
      {match && (
        <div className={`${s.cell} ${s.c5} ${s.c5match}`} style={at("5", `${afterNeeds} / ${afterRefused}`)} data-col="5">
          <HoldCapture h={match} w={w} />
        </div>
      )}
      <div className={`${s.cell} ${s.c6}`} style={at("6 / 8", `${first} / ${afterNeeds}`)} data-col="6">
        <Payout m={m} w={w} />
      </div>
      <div className={`${s.cell} ${s.band}`} style={at("5 / 8", String(afterRefused))} data-col="7">
        <Never m={m} w={w} />
      </div>
    </div>
  );
}

function PhoneRiver({ m, w }: { m: RiverModel; w: RiverWords }) {
  const ref = useRef<HTMLDivElement>(null);
  const links = useMemo(() => riverLinks(m, "y"), [m]);
  const g = useRibbons(ref, links, 44);
  const heads = steps(m, w);
  const match = m.holds.find((h) => h.kind === "match");
  const cols = (count: number) => ({ "--cols": Math.max(1, Math.min(3, count)) }) as CSSProperties;
  return (
    <div className={s.phone} ref={ref}>
      <Ribbons g={g} />
      <section className={s.sec} data-col="1">
        <StepHead n={1} step={heads[0]} />
        <div className={s.row}>
          <Receipt m={m} w={w} />
        </div>
      </section>
      <section className={s.sec} data-col="2">
        <StepHead n={2} step={heads[1]} />
        <div className={s.row}>
          <Readings m={m} w={w} />
        </div>
      </section>
      <section className={s.sec} data-col="3">
        <StepHead n={3} step={heads[2]} />
        <div className={s.grid} style={cols(m.needs.length)}>
          {m.needs.map((x) => (
            <NeedCard key={x.needId} n={x} w={w} />
          ))}
        </div>
        {m.refused.length > 0 && (
          <div className={`${s.grid} ${s.refRow}`} style={cols(m.refused.length)}>
            {m.refused.map((x) => (
              <RefusedCard key={x.lineNo} r={x} w={w} />
            ))}
          </div>
        )}
      </section>
      <section className={s.sec} data-col="4">
        <StepHead n={4} step={heads[3]} />
        <div className={s.grid} style={cols(m.needs.length)}>
          {m.needs.map((x) => (
            <div key={x.needId} className={s.stack}>
              {x.shares.map((sh) => (
                <ShareCard key={sh.pledgeId} n={x} sh={sh} w={w} />
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className={s.sec} data-col="5">
        <StepHead n={5} step={heads[4]} />
        <div className={s.stack}>
          {orderedHolds(m).map((h) => (
            <HoldCapture key={h.pledgeId} h={h} w={w} />
          ))}
          {match && <HoldCapture h={match} w={w} />}
        </div>
      </section>
      <section className={s.sec} data-col="6">
        <StepHead n={6} step={heads[5]} />
        <div className={s.row}>
          <Payout m={m} w={w} />
        </div>
      </section>
      <section className={s.sec} data-col="7">
        <StepHead n={7} step={heads[6]} />
        <div className={s.grid} style={cols(m.never.length || 1)}>
          <Never m={m} w={w} />
        </div>
      </section>
    </div>
  );
}
