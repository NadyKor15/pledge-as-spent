"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useState } from "react";
import "../panels.css";
import { journalOf, type JournalEvent } from "../journal";
import type { LedgerStore } from "../store";
import { PANEL_WORDS } from "../words-panels";
import { useWidget } from "./useWidget";

// The PayPal journal (T3): what the drive asked PayPal and PayPal's own answer, grouped as the money moved on a
// desktop, the newest five on a phone. A donor's row presses that donor, as their label on the map does; the match,
// the payout and the receipt are not anyone to press. Its height never follows the data: it scrolls inside.

const COMPACT_BELOW = 720;
const PHONE_LATEST = 5;

function useWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

const tone = (e: JournalEvent) => (e.ok === false ? "bad" : e.never || e.status === "VOIDED" ? "never" : e.ok === null ? "wait" : e.status === "CREATED" || e.status === "SUCCESS" ? "info" : "done");

function Row({ e, store, on, showOnMap }: { e: JournalEvent; store: LedgerStore; on: boolean; showOnMap: (who: string) => string }) {
  const body = (
    <>
      <time className="lg-jr-time" dateTime={e.at}>
        {e.time}
      </time>
      <span className="lg-jr-text">{e.text}</span>
      {e.status && <span className={`lg-jr-status lg-jr-${tone(e)}`}>{e.status}</span>}
    </>
  );
  if (!e.donor || !e.pledgeId) return <div className="lg-jr-row">{body}</div>;
  const pledgeId = e.pledgeId;
  const who = e.who ?? "";
  return (
    <button type="button" className={`lg-jr-row lg-jr-press${on ? " is-on" : ""}`} data-donor-event={who} aria-pressed={on} title={showOnMap(who)} onClick={() => store.toggle({ kind: "donor", pledgeId })}>
      {body}
    </button>
  );
}

export function JournalWidget(params: AgWidgetParams) {
  const { store, snap } = useWidget<HTMLElement>(params);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const width = useWidth(el);
  const compact = width > 0 && width < COMPACT_BELOW;
  const [all, setAll] = useState(false);
  const w = PANEL_WORDS[snap.lang].journal;
  const journal = useMemo(() => (snap.view ? journalOf(snap.view, snap.model, snap.lang) : null), [snap.view, snap.model, snap.lang]);
  const picked = snap.selected?.kind === "donor" ? snap.selected.pledgeId : null;
  const row = (e: JournalEvent) => <Row key={e.key} e={e} store={store} on={picked !== null && e.pledgeId === picked} showOnMap={w.showOnMap} />;

  const events = journal?.events ?? [];
  const latest = all ? [...events].reverse() : events.slice(-PHONE_LATEST).reverse();

  return (
    <section className="lg-card lg-jr" data-testid="journal-widget" data-compact={compact ? "" : undefined} aria-label={w.title} ref={setEl}>
      <header className="lg-jr-head">
        <h2>{w.title}</h2>
        {journal && <span className="lg-jr-tag">{journal.recorded ? w.recorded : w.live}</span>}
        <span className="lg-jr-utc">{w.utc}</span>
      </header>
      {!events.length ? (
        <p className="lg-jr-empty">{w.empty}</p>
      ) : compact ? (
        <div className="lg-jr-list">
          <ul>
            {latest.map((e) => (
              <li key={e.key}>{row(e)}</li>
            ))}
          </ul>
          {events.length > PHONE_LATEST && (
            <button type="button" className="lg-jr-all" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? w.latest(PHONE_LATEST) : w.all(events.length)}
            </button>
          )}
        </div>
      ) : (
        <ol className="lg-jr-groups">
          {journal!.groups.map((g) => (
            <li key={g.id} className={`lg-jr-group lg-jr-g-${g.id}`}>
              <h3>
                <i aria-hidden="true" />
                {g.title}
              </h3>
              <ul>
                {g.events.length ? (
                  g.events.map((e) => <li key={e.key}>{row(e)}</li>)
                ) : (
                  <li className="lg-jr-none">{w.noneYet}</li>
                )}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
