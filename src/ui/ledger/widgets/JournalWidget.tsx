"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../panels.css";
import { fitRows } from "../fit-rows";
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

type Tip = { who: string; left: number; top: number };

/** The map is above the journal (and above the chat on a phone): bring it into view to show the donor just pressed. */
function showMap() {
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  document.querySelector(".lg-map")?.scrollIntoView({ block: "center", behavior });
}

function Row({ e, store, on, onTip }: { e: JournalEvent; store: LedgerStore; on: boolean; onTip: (tip: Tip | null) => void }) {
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
  // The hint "Show Lena on the map" over the row's right end (S4), on hover and on keyboard focus; the section draws it.
  const tip = (el: HTMLElement) => {
    const card = el.closest(".lg-jr")?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (card) onTip({ who, left: r.right - card.left, top: r.top - card.top });
  };
  return (
    <button
      type="button"
      className={`lg-jr-row lg-jr-press${on ? " is-on" : ""}`}
      data-donor-event={who}
      aria-pressed={on}
      onClick={() => {
        store.toggle({ kind: "donor", pledgeId });
        if (store.get().selected) showMap();
      }}
      onMouseEnter={(ev) => tip(ev.currentTarget)}
      onMouseLeave={() => onTip(null)}
      onFocus={(ev) => tip(ev.currentTarget)}
      onBlur={() => onTip(null)}
    >
      {body}
    </button>
  );
}

/** The "+N more ↓" line under a column, with its margin. */
const MORE_PX = 22;

/**
 * A column's list on a desktop. Where its rows do not all fit (a laptop at 1366 or zoomed), it ends at its last whole
 * row and says how many more are below; pressing that scrolls the list. Where they all fit, nothing changes.
 */
function GroupList({ count, more, children }: { count: number; more: (n: number) => string; children: ReactNode }) {
  const list = useRef<HTMLUListElement>(null);
  const [below, setBelow] = useState(0);
  useEffect(() => {
    const ul = list.current;
    const group = ul?.parentElement;
    if (!ul || !group) return;
    const rowsBelow = () => [...ul.children].filter((r) => (r as HTMLElement).offsetTop + (r as HTMLElement).offsetHeight > ul.scrollTop + ul.clientHeight + 1).length;
    const fit = () => {
      // Measured as the layout gives it: the list fills its column.
      ul.style.height = "";
      ul.style.flex = "";
      const rows = [...ul.children] as HTMLElement[];
      const cs = getComputedStyle(ul);
      const pad = parseFloat(cs.paddingBottom) || 0;
      const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      // The room is the column's: the list's own, plus the "+N more" line's when it is already there.
      const chip = ul.nextElementSibling as HTMLElement | null;
      const chipPx = chip?.classList.contains("lg-jr-more") ? chip.offsetHeight + (parseFloat(getComputedStyle(chip).marginTop) || 0) : 0;
      const { height } = fitRows(rows.map((r) => r.offsetTop + r.offsetHeight), ul.clientHeight + chipPx, pad, MORE_PX);
      if (height !== null) {
        ul.style.flex = "none";
        ul.style.height = `${height + borders}px`;
      }
      setBelow(height === null ? 0 : rowsBelow());
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(group);
    void document.fonts?.ready.then(fit);
    const scrolled = () => setBelow(ul.style.height ? rowsBelow() : 0);
    ul.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      ro.disconnect();
      ul.removeEventListener("scroll", scrolled);
      ul.style.height = "";
      ul.style.flex = "";
    };
  }, [count]);
  const down = () => {
    const ul = list.current;
    if (ul) ul.scrollBy({ top: ul.clientHeight - 8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return (
    <>
      <ul ref={list}>{children}</ul>
      {below > 0 && (
        <button type="button" className="lg-jr-more" onClick={down}>
          {more(below)}
        </button>
      )}
    </>
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
  const [tip, setTip] = useState<Tip | null>(null);
  const row = (e: JournalEvent) => <Row key={e.key} e={e} store={store} on={picked !== null && e.pledgeId === picked} onTip={setTip} />;

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
              <GroupList count={g.events.length} more={w.more}>
                {g.events.length ? (
                  g.events.map((e) => <li key={e.key}>{row(e)}</li>)
                ) : (
                  <li className="lg-jr-none">{w.noneYet}</li>
                )}
              </GroupList>
            </li>
          ))}
        </ol>
      )}
      {tip && (
        <span className="lg-jr-tip" role="tooltip" data-testid="journal-tip" style={{ left: tip.left, top: tip.top }}>
          {w.showOnMap(tip.who)}
        </span>
      )}
    </section>
  );
}
