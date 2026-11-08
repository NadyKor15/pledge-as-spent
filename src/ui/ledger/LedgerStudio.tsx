"use client";

import { AG_GRID_LOCALE_DE, AG_GRID_LOCALE_EN, AG_GRID_LOCALE_JP } from "@ag-grid-community/locale";
import { AgStudioAiModule } from "ag-studio";
import { AG_STUDIO_LOCALE_DE, AG_STUDIO_LOCALE_EN, AG_STUDIO_LOCALE_JP } from "ag-studio-locale";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { LedgerAgent } from "@/agent/harness";
import type { ModelPlan } from "@/agent/model-plan";
import { askComponentFor } from "@/agent/ui/BookAsk";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { moneyIn, type Lang } from "../format";
import { subscribeViewport, viewportWidth } from "../stage";
import { bookCells } from "./cells";
import { deriveLedger, type LedgerModel } from "./derive";
import { LANG_TAG, parseLang, WORDS } from "./i18n";
import { LangSwitch, writeLangToUrl } from "./LangSwitch";
import "./ledger.css";
import { LedgerStore, linesOf } from "./store";
import {
  ASK_WIDGET,
  BOOK_HEAD_WIDGET,
  BOOK_ROW_PX,
  DONORS_WIDGET,
  FOOTER_WIDGET,
  ledgerData,
  ledgerState,
  MAP_WIDGET,
  NOTE_WIDGET,
  PHONE_BOOK_ROW_PX,
  SHELTER_WIDGET,
  type Metrics,
} from "./studio-state";
import { ledgerTheme } from "./theme";
import type { DriveView } from "../types";
import { AskSlotWidget } from "./widgets/AskSlotWidget";
import { BookHeadWidget } from "./widgets/BookHeadWidget";
import { DonorsWidget } from "./widgets/DonorsWidget";
import { FooterWidget } from "./widgets/FooterWidget";
import { MapWidget } from "./widgets/MapWidget";
import { NoteWidget } from "./widgets/NoteWidget";
import { ShelterWidget } from "./widgets/ShelterWidget";

const noForm = (params: { createDefaults: (p: { dataMappingItems: never[] }) => never }) => params.createDefaults({ dataMappingItems: [] });
const SIZE = { width: 4, height: 4 };

/** Studio's own words and its grid's, in the book's language (only these three are imported). */
const STUDIO_LOCALE: Record<Lang, Record<string, string>> = { en: AG_STUDIO_LOCALE_EN, de: AG_STUDIO_LOCALE_DE, ja: AG_STUDIO_LOCALE_JP };
const GRID_LOCALE: Record<Lang, Record<string, string>> = { en: AG_GRID_LOCALE_EN, de: AG_GRID_LOCALE_DE, ja: AG_GRID_LOCALE_JP };

/** One set of widgets per store and language: the book's cells read that store, its grid speaks that language. */
function widgetsFor(store: LedgerStore, lang: Lang) {
  // Our widget ids are not in Studio's default registry, whose type this argument expects.
  return createWidgets({
    overrides: [{ id: "grid", options: { localeText: GRID_LOCALE[lang], createCellRenderer: bookCells(store) } }],
    additionalTypes: [
      { id: MAP_WIDGET, label: "Money map", comp: MapWidget, form: noForm, defaultSize: SIZE, minSize: SIZE, dataMapping: { lineKey: { type: "field", supportedRoles: ["category"] } } },
      { id: SHELTER_WIDGET, label: "Shelter", comp: ShelterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
      { id: DONORS_WIDGET, label: "Donors", comp: DonorsWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
      { id: FOOTER_WIDGET, label: "Bottom line", comp: FooterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
      { id: NOTE_WIDGET, label: "Note", comp: NoteWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
      { id: BOOK_HEAD_WIDGET, label: "The book", comp: BookHeadWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
      { id: ASK_WIDGET, label: "Ask the book", comp: AskSlotWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    ],
  } as never);
}

// No side panels: in view mode the filters panel would otherwise open by itself.
const PANELS = { view: { left: [], right: [] }, edit: { left: [], right: [] } };
const LAYOUT = (rowHeight: number) => ({ columns: 48, rowHeight, minWidth: 320, pagePadding: 0, widgetPadding: 0, widgetBorderEnabled: false });
const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE;
/** Studio's AI module: the agent's harness, its built-in data agent and its read-only tools. */
const MODULES = [AgStudioAiModule];

/** The page's store and its agent, made once: the chat is in the slot from the first render, so Studio is built once. */
function makeBook(view: DriveView, modelPlan: ModelPlan) {
  const lang = langFromUrl();
  const store = new LedgerStore(deriveLedger(view, lang), view);
  const agent = new LedgerAgent({ getView: () => store.get().view ?? view, locale: () => store.get().lang, modelPlan });
  store.setAskComponent(askComponentFor(agent));
  store.setAskAbout((lineKey) => {
    agent.askAboutLine(lineKey);
    // The chat is over the book: bring it into view with the question in it.
    const ask = document.querySelector('[data-testid="ask-widget"]');
    ask?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  return { store, agent };
}

const REF_W = 1440;
const REF_H = 900;

const subscribeSize = subscribeViewport;
const sizeKey = () => `${viewportWidth()}x${window.innerHeight}`;

/** The book's height: a header and up to this many rows, then it scrolls inside its own grid. */
const BOOK_ROWS = 22;
const bookHeight = (rows: number, stacked: boolean) => 60 + Math.min(rows, BOOK_ROWS) * (stacked ? PHONE_BOOK_ROW_PX : BOOK_ROW_PX);
/**
 * The proof band under a row measures itself (store.bandPx) and the rows below it move down exactly that much
 * (ledger.css --band-h). These are its height before the first measure, and the room the book's widget keeps for
 * it: more than any band needs, so a band never pushes the book's last rows out of the widget.
 */
export const BAND_PX = 132;
export const PHONE_BAND_PX = 252;
const BAND_ROOM_PX = 360;
const PHONE_BAND_ROOM_PX = 560;
const bandHeight = (stacked: boolean) => (stacked ? PHONE_BAND_PX : BAND_PX);
const bandRoom = (stacked: boolean) => (stacked ? PHONE_BAND_ROOM_PX : BAND_ROOM_PX);
/** "The book" over it, in pixels at scale 1. */
const BOOK_HEAD_PX = 60;
/** The assistant's chat over the book, in pixels at scale 1; the assistant's lane sizes its widget to this. */
export const ASK_PX = 460;
export const PHONE_ASK_PX = 640;

function metricsFor(stacked: boolean, width: number, scale: number, counts: { needs: number; donors: number; book: number; waiting: boolean; rest: boolean; ask: boolean }): Metrics {
  // The book's widget keeps room for the band at all times: opening one moves the frame's edge, never Studio's layout.
  const bookRows = (rowHeight: number) => Math.ceil((bookHeight(counts.book, stacked) + bandRoom(stacked)) / rowHeight);
  if (stacked) {
    const rowHeight = 10;
    const rows = {
      kpi: 12,
      pair: 9,
      match: 4,
      note: counts.waiting || counts.rest ? 4 : 0,
      map: Math.ceil((Math.min(width, 640) * 0.56) / rowHeight),
      shelter: Math.ceil((112 + counts.needs * 104) / rowHeight),
      donors: Math.ceil((62 + counts.donors * 78) / rowHeight),
      footer: 13,
      ask: counts.ask ? Math.ceil(PHONE_ASK_PX / rowHeight) : 0,
      head: Math.ceil(BOOK_HEAD_PX / rowHeight),
      book: bookRows(rowHeight),
    };
    return { rowHeight, stacked, scale: 1, rows };
  }
  const rowHeight = 10 * scale;
  // The line under Spent takes its height from the map, so the page stays one screen tall.
  const note = counts.waiting ? 3 : 0;
  return {
    rowHeight,
    stacked,
    scale,
    rows: { kpi: 19 + note, pair: 0, match: 4, note, map: 56 - note, shelter: 56 - note, donors: 0, footer: 9, ask: counts.ask ? Math.ceil(ASK_PX / 10) : 0, head: Math.ceil(BOOK_HEAD_PX / 10), book: bookRows(rowHeight) },
  };
}

function useMetrics(stacked: boolean, model: LedgerModel, ask: boolean): Metrics {
  const size = useSyncExternalStore(subscribeSize, sizeKey, () => `${REF_W}x${REF_H}`);
  const [w, h] = size.split("x").map(Number);
  // The composition keeps its proportions: narrower or shorter windows scale it, in steps
  // so that a window being dragged does not rebuild the report on every pixel.
  const scale = stacked ? 1 : Math.round(Math.max(0.74, Math.min(1.34, w / REF_W, (h - 8) / REF_H)) * 20) / 20;
  const width = stacked ? w : REF_W;
  const needs = model.needs.length;
  const donors = model.donors.length;
  const book = model.book.length;
  const waiting = model.waitingNote !== null;
  const rest = model.restNote !== null;
  return useMemo(() => metricsFor(stacked, width, scale, { needs, donors, book, waiting, rest, ask }), [stacked, width, scale, needs, donors, book, waiting, rest, ask]);
}

/** Page height in tracks, without the book: the report never scrolls inside itself. The assistant's chat is part of it. */
function bodyRows(m: Metrics, matched: boolean) {
  const r = m.rows;
  return (m.stacked ? r.kpi + r.pair + r.note + (matched ? r.match : 0) + r.map + r.shelter + r.donors + r.footer : r.kpi + r.map + r.footer) + r.ask;
}

function useCountUp(root: React.RefObject<HTMLDivElement | null>, model: LedgerModel, run: number, layoutKey: string) {
  const { promised, spent, rest, baseCurrency } = model;
  const lang = model.lang ?? "en";
  useEffect(() => {
    // The totals as the value widgets print them, in the page's language.
    const money = (currency: string, minor: number) => moneyIn(lang, currency, minor);
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = [
      { value: promised, delay: 100, spanMs: 1100 },
      { value: spent, delay: 450, spanMs: 1100 },
      { value: rest, delay: 1500, spanMs: 1000 },
    ].map((t) => ({ ...t, text: money(baseCurrency, t.value) }));
    let frame = 0;
    let observer: MutationObserver | null = null;
    const start = () => {
      const nodes = targets.map((t) => [...el.querySelectorAll<HTMLElement>(".ag-studio-value-widget-content")].find((n) => n.textContent === t.text));
      if (nodes.some((n) => !n)) return false;
      observer?.disconnect();
      const t0 = performance.now();
      nodes.forEach((n, i) => {
        n!.textContent = money(baseCurrency, 0);
        n!.dataset.counting = String(i);
      });
      const tick = (now: number) => {
        let busy = false;
        targets.forEach((t, i) => {
          const p = Math.max(0, Math.min(1, (now - t0 - t.delay) / t.spanMs));
          const eased = 1 - (1 - p) ** 3;
          nodes[i]!.textContent = p >= 1 ? t.text : money(baseCurrency, Math.round(t.value * eased));
          busy ||= p < 1;
        });
        if (busy) frame = requestAnimationFrame(tick);
        else nodes.forEach((n) => delete n!.dataset.counting);
      };
      frame = requestAnimationFrame(tick);
      return true;
    };
    if (!start()) {
      observer = new MutationObserver(() => void start());
      observer.observe(el, { subtree: true, childList: true, characterData: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      el.querySelectorAll<HTMLElement>("[data-counting]").forEach((n) => {
        n.textContent = targets[Number(n.dataset.counting)].text;
        delete n.dataset.counting;
      });
    };
  }, [root, promised, spent, rest, baseCurrency, run, layoutKey, lang]);
}

const langFromUrl = (): Lang => parseLang(new URLSearchParams(window.location.search).get("lang"));

/** One AG Studio report. Everything here is client-only and loads with this tab alone. */
export function LedgerStudio({ view, stacked, stale, refresh, modelPlan = "nova" }: { view: DriveView; stacked: boolean; stale: boolean; refresh: () => Promise<unknown>; modelPlan?: ModelPlan }) {
  const [{ store, agent }] = useState(() => makeBook(view, modelPlan));
  useEffect(() => () => agent.dispose(), [agent]);
  const lang = useSyncExternalStore(store.subscribe, () => store.get().lang);
  // The drive is re-read every few seconds after an action. The same figures must stay the same
  // object, or every read would rebuild Studio's data and start the count over.
  const json = useMemo(() => JSON.stringify(deriveLedger(view, lang)), [view, lang]);
  const model = useMemo(() => JSON.parse(json) as LedgerModel, [json]);
  const run = useSyncExternalStore(store.subscribe, () => store.get().run);
  const bookOpen = useSyncExternalStore(store.subscribe, () => store.get().bookOpen);
  const selected = useSyncExternalStore(store.subscribe, () => store.get().selected);
  const focus = useSyncExternalStore(store.subscribe, () => store.get().focus);
  const proof = useSyncExternalStore(store.subscribe, () => store.get().proof);
  const ask = useSyncExternalStore(store.subscribe, () => store.get().askComponent !== null);
  const bandPx = useSyncExternalStore(store.subscribe, () => store.get().bandPx) ?? bandHeight(stacked);
  const picked = focus ? focus.lineKeys : selected ? linesOf(model, selected) : null;
  const metrics = useMetrics(stacked, model, ask);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    store.setView(view);
    store.setModel(model);
  }, [store, view, model]);
  // The store on the report's element, for the browser console and the end-to-end tests. It moves no money: every
  // method changes what this page shows, and the data in it is what GET /api/drives already returns to anyone.
  useEffect(() => {
    const el = root.current as (HTMLDivElement & { ledgerStore?: LedgerStore }) | null;
    if (!el) return;
    el.ledgerStore = store;
    return () => {
      delete el.ledgerStore;
    };
  }, [store]);
  useEffect(() => {
    store.setRefresh(() => void refresh());
    store.setStale(stale);
  }, [store, stale, refresh]);

  const setLang = (next: Lang) => {
    writeLangToUrl(next);
    store.setLang(next);
  };

  // The language rebuilds Studio: its own words are read once (AG Studio 3.0.0, Localisation).
  const layoutKey = `${stacked ? "s" : "d"}-${metrics.scale}-${JSON.stringify(metrics.rows)}-${model.phase}-${model.spentLabel}-${lang}`;
  useCountUp(root, model, run, layoutKey);

  const widgets = useMemo(() => widgetsFor(store, lang), [store, lang]);
  const data = useMemo(() => ledgerData(model, lang), [model, lang]);
  const context = useMemo(() => ({ store }), [store]);
  const initialState = useMemo(() => ledgerState(model, metrics, lang), [model, metrics, lang]);

  useEffect(() => {
    if (!bookOpen) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior }));
  }, [bookOpen]);

  // The book is always in the report, below the fold of this frame. Opening it moves the frame's
  // edge and nothing else: Studio keeps its full height and is never told, so no widget rebuilds.
  // A filtered book is shorter than its widget: the frame ends with its last row.
  const body = bodyRows(metrics, model.matchName !== null) * metrics.rowHeight + 4;
  const head = metrics.rows.head * metrics.rowHeight;
  const whole = body + head + metrics.rows.book * metrics.rowHeight;
  const lines = picked ? model.book.filter((r) => picked.includes(r.lineKey)).length : model.book.length;
  const banded = proof !== null && model.book.some((r) => r.rowKey === proof && (!picked || picked.includes(r.lineKey)));
  const height = body + (bookOpen ? head + bookHeight(lines, stacked) + (banded ? bandPx : 0) : 0);
  const w = WORDS[lang];

  return (
    <div
      className="lg-screen"
      ref={root}
      lang={LANG_TAG[lang]}
      data-phase={model.phase}
      data-stacked={stacked}
      style={{ "--s": metrics.scale, "--band-h": `${bandPx}px`, "--row-h": `${stacked ? PHONE_BOOK_ROW_PX : BOOK_ROW_PX}px` } as CSSProperties}
    >
      <div className="lg-frame" data-book={bookOpen && lines > 0 ? "open" : "closed"} style={{ height }}>
        {bookOpen && lines === 0 && (
          <p className="lg-nolines" style={{ top: body + head }}>
            {w.noLines}
          </p>
        )}
        {stacked ? (
          <i className="lg-rule lg-rule-pair" />
        ) : (
          <>
            <i className="lg-rule" style={{ left: "33.33%" }} />
            <i className="lg-rule" style={{ left: "66.66%" }} />
          </>
        )}
        <AgStudioProvider modules={MODULES} {...(LICENSE ? { licenseKey: LICENSE } : {})}>
          <div style={{ height: whole }}>
            <AgStudio
              key={layoutKey}
              style={{ width: "100%", height: "100%" }}
              theme={ledgerTheme}
              data={data}
              context={context}
              widgets={widgets}
              localeText={STUDIO_LOCALE[lang]}
              initialState={initialState}
              mode="view"
              panels={PANELS}
              layout={LAYOUT(metrics.rowHeight)}
              onStudioReady={(e) => void agent.attach(e.api)}
            />
          </div>
        </AgStudioProvider>
        {/* After the report in the page's order: Tab walks the report first (review finding 17), then the language. */}
        <LangSwitch lang={lang} onChange={setLang} />
      </div>
    </div>
  );
}
