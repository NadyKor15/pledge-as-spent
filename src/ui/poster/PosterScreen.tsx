"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useEffect, useMemo, useSyncExternalStore } from "react";
import { useDrive } from "../api";
import { classes } from "../cls";
import { NeedIcon } from "../icons";
import { LANG_TAG, parseLang } from "../ledger/i18n";
import { Failure, Loading } from "../states";
import type { DriveView } from "../types";
import { posterModel } from "./model";
import { qrModules, qrPath } from "./qr";
import { POSTER_WORDS } from "./words";
import "./poster.css";

const s = classes("pp");

/** The demo needs' pictures, the same files the Ledger's shelter card shows; any other need gets its drawn icon. */
const PICTURES: Record<string, { src: string; w: number; h: number }> = {
  water: { src: "/ledger/water.png", w: 100, h: 150 },
  diapers: { src: "/ledger/diapers.png", w: 130, h: 130 },
  batteries: { src: "/ledger/batteries.png", w: 60, h: 130 },
};

function NeedPicture({ needId }: { needId: string }) {
  const p = PICTURES[needId];
  if (!p) return <NeedIcon needId={needId} size={44} />;
  return <Image className={s.pic} src={p.src} alt="" width={p.w} height={p.h} loading="eager" unoptimized />;
}

const noSubscribe = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => null;

/** `@page` is global: it exists only while the poster does. */
function usePageRule() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = "@page { size: A4 portrait; margin: 12mm; }";
    document.head.append(el);
    return () => el.remove();
  }, []);
}

/** The shelter's A4 poster: what was bought here, and a QR code to the drive's book. A button prints it. */
export function PosterScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const d = useDrive(id);
  usePageRule();
  if (!d.view) {
    if (!d.error) return <Loading what="the poster" />;
    return <Failure title={d.error.status === 404 ? "No such drive" : "The poster could not be loaded"} message={d.error.message} />;
  }
  return <Poster view={d.view} />;
}

function Poster({ view }: { view: DriveView }) {
  const lang = parseLang(useSearchParams().get("lang"));
  const w = POSTER_WORDS[lang];
  // The address the QR code opens is this site's own: known only in the browser (null while rendered on the server).
  const origin = useSyncExternalStore(noSubscribe, browserOrigin, serverOrigin);
  const m = useMemo(() => (origin ? posterModel(view, lang, origin) : null), [view, lang, origin]);
  const qr = useMemo(() => (m ? qrModules(m.url) : null), [m]);
  if (!m || !qr) return <Loading what="the poster" />;
  const n = qr.length;
  const book = `/drive/${encodeURIComponent(view.drive.id)}?as=ledger${lang === "en" ? "" : `&lang=${lang}`}`;

  return (
    <div className={s.root} lang={LANG_TAG[lang]}>
      <div className={s.bar}>
        <button type="button" className={s.print} onClick={() => window.print()} data-testid="print-poster">
          {w.print}
        </button>
        <span className={s.hint}>{w.printHint}</span>
        <Link className={s.back} href={book}>
          {w.back}
        </Link>
      </div>

      <article className={s.sheet} data-testid="poster-sheet" data-url={m.url}>
        <header className={s.head}>
          <p className={s.brand}>Pledge-as-Spent · {m.badge}</p>
          <h1 className={s.shelter}>{m.shelter}</h1>
          {(m.disaster || m.since) && <p className={s.disaster}>{[m.disaster, m.since].filter(Boolean).join(" · ")}</p>}
        </header>

        <h2 className={s.title}>{w.title}</h2>
        {m.total ? (
          <>
            <ul className={s.needs}>
              {m.needs.map((x) => (
                <li key={x.needId} className={s.need} data-need={x.needId}>
                  <NeedPicture needId={x.needId} />
                  <span className={s.label}>{x.label}</span>
                  <span className={s.count}>{x.count}</span>
                  <span className={s.bar2} aria-hidden="true">
                    <i style={{ width: `${x.percent}%` }} />
                  </span>
                </li>
              ))}
            </ul>
            <p className={s.total}>
              <span>{w.inTotal}</span> <b>{m.total}</b>
            </p>
          </>
        ) : (
          <p className={s.none}>{w.nothingYet}</p>
        )}

        <p className={s.checked}>{w.checked}</p>

        <footer className={s.foot}>
          <svg className={s.qr} viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label={m.url} data-testid="poster-qr" data-modules={n} shapeRendering="crispEdges">
            <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#FFFFFF" />
            <path d={qrPath(qr)} fill="#0B1222" />
          </svg>
          <div className={s.scan}>
            <p>{w.scan}</p>
            <p className={s.url}>{m.url}</p>
          </div>
        </footer>
      </article>
    </div>
  );
}
