"use client";

import type { AgWidgetField } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { GridApi } from "ag-grid-community";
import type { CustomCellRendererProps } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { money } from "../format";
import { deriveLedger, type LedgerModel } from "./derive";
import "./ledger.css";
import { LedgerStore, linesOf } from "./store";
import { DONORS_WIDGET, FOOTER_WIDGET, ledgerData, ledgerState, MAP_WIDGET, NEED_FIELD, NOTE_WIDGET, ORDER_FIELD, SHELTER_WIDGET, WHAT_FIELD, type Metrics } from "./studio-state";
import { ledgerTheme } from "./theme";
import type { DriveView } from "../types";
import { DonorsWidget } from "./widgets/DonorsWidget";
import { FooterWidget } from "./widgets/FooterWidget";
import { MapWidget } from "./widgets/MapWidget";
import { NoteWidget } from "./widgets/NoteWidget";
import { ShelterWidget } from "./widgets/ShelterWidget";

const noForm = (params: { createDefaults: (p: { dataMappingItems: never[] }) => never }) => params.createDefaults({ dataMappingItems: [] });
const SIZE = { width: 4, height: 4 };

// Share of the book's width and the least each column can do with. Studio's own auto-size gives
// the free room to Line and leaves the items just wide enough, then redoes it on every filter.
const COLUMNS: [id: string, share: number, least: number][] = [
  ["book.line", 0.05, 56],
  ["book.item", 0.25, 240],
  ["book.need", 0.14, 130],
  ["book.payer", 0.15, 150],
  ["book.share", 0.07, 80],
  ["book.charged", 0.08, 90],
  ["book.capture", 0.16, 190],
  ["book.status", 0.1, 100],
];

const PHONE_COLUMNS: typeof COLUMNS = [
  ["book.what", 0.37, 130],
  ["book.who", 0.2, 70],
  ["book.much", 0.24, 84],
  ["book.state", 0.19, 66],
];

const listening = new WeakSet<GridApi>();
const queued = new WeakSet<GridApi>();

/** Puts the columns back at their shares, at most once a frame. Studio sizes them again after each refresh. */
function holdColumns(api: GridApi, grid: Element) {
  if (queued.has(api)) return;
  queued.add(api);
  requestAnimationFrame(() => {
    queued.delete(api);
    const width = grid.clientWidth;
    if (api.isDestroyed() || !width) return;
    const target = (api.getColumn(NEED_FIELD) ? COLUMNS : PHONE_COLUMNS).map(([key, share, least]) => ({ key, newWidth: Math.max(least, Math.floor(width * share)) }));
    const off = target.some(({ key, newWidth }) => Math.abs((api.getColumn(key)?.getActualWidth() ?? newWidth) - newWidth) > 1);
    if (off) api.setColumnWidths(target, true);
    if (api.getColumn(ORDER_FIELD)?.isVisible()) api.setColumnsVisible([ORDER_FIELD], false);
  });
}

function watchColumns(api: GridApi, grid: Element) {
  if (listening.has(api)) return;
  listening.add(api);
  for (const event of ["storeRefreshed", "modelUpdated", "gridSizeChanged", "columnResized"] as const) api.addEventListener(event, () => holdColumns(api, grid));
}

/** The grid widget is flat, so a group shows as its first row: the need in bold, then its other lines. */
function NeedCell({ api, node, column, value, eGridCell }: CustomCellRendererProps) {
  const above = node.rowIndex ? api.getDisplayedRowAtIndex(node.rowIndex - 1) : undefined;
  const first = !above || !column || above.data?.[column.getColId()] !== value;
  useEffect(() => {
    // The grid's root, not this cell: the cell leaves the page with the next filter, the root stays.
    const grid = eGridCell.closest(".ag-root-wrapper");
    if (!grid) return;
    watchColumns(api, grid);
    holdColumns(api, grid);
  });
  return <span className={first ? "lg-group" : "lg-group-more"}>{String(value ?? "")}</span>;
}

/** The phone's first column: its text is plain, and it is what keeps the columns at their shares there. */
function WhatCell({ api, value, eGridCell }: CustomCellRendererProps) {
  useEffect(() => {
    const grid = eGridCell.closest(".ag-root-wrapper");
    if (!grid) return;
    watchColumns(api, grid);
    holdColumns(api, grid);
  });
  return <span>{String(value ?? "")}</span>;
}

// Our widget ids are not in Studio's default registry, whose type this argument expects.
const WIDGETS = createWidgets({
  overrides: [{ id: "grid", options: { createCellRenderer: (f: AgWidgetField) => (f.fieldId === NEED_FIELD ? NeedCell : f.fieldId === WHAT_FIELD ? WhatCell : undefined) } }],
  additionalTypes: [
    { id: MAP_WIDGET, label: "Money map", comp: MapWidget, form: noForm, defaultSize: SIZE, minSize: SIZE, dataMapping: { lineKey: { type: "field", supportedRoles: ["category"] } } },
    { id: SHELTER_WIDGET, label: "Shelter", comp: ShelterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    { id: DONORS_WIDGET, label: "Donors", comp: DonorsWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    { id: FOOTER_WIDGET, label: "Bottom line", comp: FooterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    { id: NOTE_WIDGET, label: "Note", comp: NoteWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
  ],
} as never);

// No side panels: in view mode the filters panel would otherwise open by itself.
const PANELS = { view: { left: [], right: [] }, edit: { left: [], right: [] } };
const LAYOUT = (rowHeight: number) => ({ columns: 48, rowHeight, minWidth: 320, pagePadding: 0, widgetPadding: 0, widgetBorderEnabled: false });
const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE;

const REF_W = 1440;
const REF_H = 900;

function subscribeSize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const sizeKey = () => `${document.documentElement.clientWidth}x${window.innerHeight}`;

/** The book's height: a header and up to this many rows, then it scrolls inside its own grid. */
const BOOK_ROWS = 22;
const bookHeight = (rows: number) => 60 + Math.min(rows, BOOK_ROWS) * 38;

function metricsFor(stacked: boolean, width: number, scale: number, counts: { needs: number; donors: number; book: number; waiting: boolean; rest: boolean }): Metrics {
  const bookRows = (rowHeight: number) => Math.ceil(bookHeight(counts.book) / rowHeight);
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
      book: bookRows(rowHeight),
    };
    return { rowHeight, stacked, scale: 1, rows };
  }
  const rowHeight = 10 * scale;
  // The line under Spent takes its height from the map, so the page stays one screen tall.
  const note = counts.waiting ? 3 : 0;
  return { rowHeight, stacked, scale, rows: { kpi: 19 + note, pair: 0, match: 4, note, map: 56 - note, shelter: 56 - note, donors: 0, footer: 9, book: bookRows(rowHeight) } };
}

function useMetrics(stacked: boolean, model: LedgerModel): Metrics {
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
  return useMemo(() => metricsFor(stacked, width, scale, { needs, donors, book, waiting, rest }), [stacked, width, scale, needs, donors, book, waiting, rest]);
}

/** Page height in tracks, without the book: the report never scrolls inside itself. */
function bodyRows(m: Metrics, matched: boolean) {
  const r = m.rows;
  return m.stacked ? r.kpi + r.pair + r.note + (matched ? r.match : 0) + r.map + r.shelter + r.donors + r.footer : r.kpi + r.map + r.footer;
}

function useCountUp(root: React.RefObject<HTMLDivElement | null>, model: LedgerModel, run: number, layoutKey: string) {
  const { promised, spent, rest, baseCurrency } = model;
  useEffect(() => {
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
  }, [root, promised, spent, rest, baseCurrency, run, layoutKey]);
}

/** One AG Studio report. Everything here is client-only and loads with this tab alone. */
export function LedgerStudio({ view, stacked, stale, refresh }: { view: DriveView; stacked: boolean; stale: boolean; refresh: () => Promise<unknown> }) {
  // The drive is re-read every few seconds after an action. The same figures must stay the same
  // object, or every read would rebuild Studio's data and start the count over.
  const json = useMemo(() => JSON.stringify(deriveLedger(view)), [view]);
  const model = useMemo(() => JSON.parse(json) as LedgerModel, [json]);
  const [store] = useState(() => new LedgerStore(model));
  const run = useSyncExternalStore(store.subscribe, () => store.get().run);
  const bookOpen = useSyncExternalStore(store.subscribe, () => store.get().bookOpen);
  const selected = useSyncExternalStore(store.subscribe, () => store.get().selected);
  const picked = selected ? linesOf(model, selected) : null;
  const metrics = useMetrics(stacked, model);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => store.setModel(model), [store, model]);
  useEffect(() => {
    store.setRefresh(() => void refresh());
    store.setStale(stale);
  }, [store, stale, refresh]);

  const layoutKey = `${stacked ? "s" : "d"}-${metrics.scale}-${JSON.stringify(metrics.rows)}-${model.phase}-${model.spentLabel}`;
  useCountUp(root, model, run, layoutKey);

  const data = useMemo(() => ledgerData(model), [model]);
  const context = useMemo(() => ({ store }), [store]);
  const initialState = useMemo(() => ledgerState(model, metrics), [model, metrics]);

  useEffect(() => {
    if (!bookOpen) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior }));
  }, [bookOpen]);

  // The book is always in the report, below the fold of this frame. Opening it moves the frame's
  // edge and nothing else: Studio keeps its full height and is never told, so no widget rebuilds.
  // A filtered book is shorter than its widget: the frame ends with its last row.
  const body = bodyRows(metrics, model.matchName !== null) * metrics.rowHeight + 4;
  const whole = body + metrics.rows.book * metrics.rowHeight;
  const lines = picked ? model.book.filter((r) => picked.includes(r.lineKey)).length : model.book.length;
  const height = body + (bookOpen ? bookHeight(lines) : 0);

  return (
    <div className="lg-screen" ref={root} data-phase={model.phase} data-stacked={stacked} style={{ "--s": metrics.scale } as CSSProperties}>
      <div className="lg-frame" data-book={bookOpen && lines > 0 ? "open" : "closed"} style={{ height }}>
        {bookOpen && lines === 0 && (
          <p className="lg-nolines" style={{ top: body }}>
            No lines yet
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
        <AgStudioProvider {...(LICENSE ? { licenseKey: LICENSE } : {})}>
          <div style={{ height: whole }}>
            <AgStudio
              key={layoutKey}
              style={{ width: "100%", height: "100%" }}
              theme={ledgerTheme}
              data={data}
              context={context}
              widgets={WIDGETS}
              initialState={initialState}
              mode="view"
              panels={PANELS}
              layout={LAYOUT(metrics.rowHeight)}
            />
          </div>
        </AgStudioProvider>
      </div>
    </div>
  );
}
