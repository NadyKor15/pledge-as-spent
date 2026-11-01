"use client";

import type { AgReportState, AgStudioApi, AgWidgetField } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { CustomCellRendererProps } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { money } from "../format";
import { deriveLedger, type LedgerModel } from "./derive";
import "./ledger.css";
import { LedgerStore, linesOf } from "./store";
import { DONORS_WIDGET, FOOTER_WIDGET, ledgerData, ledgerState, MAP_WIDGET, NEED_FIELD, SHELTER_WIDGET, type Metrics } from "./studio-state";
import { ledgerTheme } from "./theme";
import type { DriveView } from "../types";
import { DonorsWidget } from "./widgets/DonorsWidget";
import { FooterWidget } from "./widgets/FooterWidget";
import { MapWidget } from "./widgets/MapWidget";
import { ShelterWidget } from "./widgets/ShelterWidget";

const noForm = (params: { createDefaults: (p: { dataMappingItems: never[] }) => never }) => params.createDefaults({ dataMappingItems: [] });
const SIZE = { width: 4, height: 4 };

/** The grid widget is flat, so a group shows as its first row: the need in bold, then its other lines. */
function NeedCell({ api, node, column, value }: CustomCellRendererProps) {
  const above = node.rowIndex ? api.getDisplayedRowAtIndex(node.rowIndex - 1) : undefined;
  const first = !above || !column || above.data?.[column.getColId()] !== value;
  return <span className={first ? "lg-group" : "lg-group-more"}>{String(value ?? "")}</span>;
}

const WIDGETS = createWidgets({
  overrides: [{ id: "grid", options: { createCellRenderer: (f: AgWidgetField) => (f.fieldId === NEED_FIELD ? NeedCell : undefined) } }],
  additionalTypes: [
    { id: MAP_WIDGET, label: "Money map", comp: MapWidget, form: noForm, defaultSize: SIZE, minSize: SIZE, dataMapping: { lineKey: { type: "field", supportedRoles: ["category"] } } },
    { id: SHELTER_WIDGET, label: "Shelter", comp: ShelterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    { id: DONORS_WIDGET, label: "Donors", comp: DonorsWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
    { id: FOOTER_WIDGET, label: "Bottom line", comp: FooterWidget, form: noForm, defaultSize: SIZE, minSize: SIZE },
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

function metricsFor(stacked: boolean, width: number, scale: number, counts: { needs: number; donors: number; book: number }): Metrics {
  const bookRows = (rowHeight: number) => Math.ceil(bookHeight(counts.book) / rowHeight);
  if (stacked) {
    const rowHeight = 10;
    const rows = {
      kpi: 12,
      pair: 9,
      match: 4,
      map: Math.ceil((Math.min(width, 640) * 0.56) / rowHeight),
      shelter: Math.ceil((64 + counts.needs * 104) / rowHeight),
      donors: Math.ceil((62 + counts.donors * 78) / rowHeight),
      footer: 10,
      book: bookRows(rowHeight),
    };
    return { rowHeight, stacked, scale: 1, rows };
  }
  const rowHeight = 10 * scale;
  return { rowHeight, stacked, scale, rows: { kpi: 19, pair: 0, match: 4, map: 56, shelter: 56, donors: 0, footer: 9, book: bookRows(rowHeight) } };
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
  return useMemo(() => metricsFor(stacked, width, scale, { needs, donors, book }), [stacked, width, scale, needs, donors, book]);
}

/** Page height in tracks, without the book: the report never scrolls inside itself. */
function bodyRows(m: Metrics, matched: boolean) {
  const r = m.rows;
  return m.stacked ? r.kpi + r.pair + (matched ? r.match : 0) + r.map + r.shelter + r.donors + r.footer : r.kpi + r.map + r.footer;
}

function useCountUp(root: React.RefObject<HTMLDivElement | null>, model: LedgerModel, run: number, layoutKey: string) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = [
      { value: model.promised, delay: 100, spanMs: 1100 },
      { value: model.spent, delay: 450, spanMs: 1100 },
      { value: model.rest, delay: 1500, spanMs: 1000 },
    ].map((t) => ({ ...t, text: money(model.baseCurrency, t.value) }));
    let frame = 0;
    let observer: MutationObserver | null = null;
    const start = () => {
      const nodes = targets.map((t) => [...el.querySelectorAll<HTMLElement>(".ag-studio-value-widget-content")].find((n) => n.textContent === t.text));
      if (nodes.some((n) => !n)) return false;
      observer?.disconnect();
      const t0 = performance.now();
      nodes.forEach((n, i) => {
        n!.textContent = money(model.baseCurrency, 0);
        n!.dataset.counting = String(i);
      });
      const tick = (now: number) => {
        let busy = false;
        targets.forEach((t, i) => {
          const p = Math.max(0, Math.min(1, (now - t0 - t.delay) / t.spanMs));
          const eased = 1 - (1 - p) ** 3;
          nodes[i]!.textContent = p >= 1 ? t.text : money(model.baseCurrency, Math.round(t.value * eased));
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
  }, [root, model, run, layoutKey]);
}

/** One AG Studio report. Everything here is client-only and loads with this tab alone. */
export function LedgerStudio({ view, stacked }: { view: DriveView; stacked: boolean }) {
  const model = useMemo(() => deriveLedger(view), [view]);
  const [store] = useState(() => new LedgerStore(model));
  const run = useSyncExternalStore(store.subscribe, () => store.get().run);
  const bookOpen = useSyncExternalStore(store.subscribe, () => store.get().bookOpen);
  const selected = useSyncExternalStore(store.subscribe, () => store.get().selected);
  const picked = selected ? linesOf(model, selected) : null;
  const metrics = useMetrics(stacked, model);
  const root = useRef<HTMLDivElement>(null);
  const studio = useRef<{ key: string; api: AgStudioApi } | null>(null);

  useEffect(() => store.setModel(model), [store, model]);

  const layoutKey = `${stacked ? "s" : "d"}-${metrics.scale}-${metrics.rows.map}-${model.phase}`;
  useCountUp(root, model, run, layoutKey);

  const data = useMemo(() => ledgerData(model), [model]);
  const context = useMemo(() => ({ store }), [store]);
  const initialState = useMemo(() => ledgerState(model, metrics, bookOpen), [model, metrics, bookOpen]);

  // The book is a widget of the report: opening it adds that widget and keeps everything else.
  useEffect(() => {
    if (studio.current?.key !== layoutKey) return;
    const { api } = studio.current;
    const current = api.getState();
    const crossFilter = current.pages[0].crossFilter;
    api.setState({ ...current, pages: [{ ...initialState.pages[0], crossFilter }] } as AgReportState);
    if (bookOpen) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
  }, [bookOpen, initialState, layoutKey]);

  // A filtered book is shorter than its widget: the frame ends with the last row.
  const bookShown = bookOpen ? bookHeight(picked ? model.book.filter((r) => picked.includes(r.lineKey)).length : model.book.length) : 0;
  const height = bodyRows(metrics, model.matchName !== null) * metrics.rowHeight + bookShown + 4;

  return (
    <div className="lg-screen" ref={root} data-phase={model.phase} data-stacked={stacked} style={{ "--s": metrics.scale } as CSSProperties}>
      <div className="lg-frame" style={{ height }}>
        {stacked ? (
          <i className="lg-rule lg-rule-pair" />
        ) : (
          <>
            <i className="lg-rule" style={{ left: "33.33%" }} />
            <i className="lg-rule" style={{ left: "66.66%" }} />
          </>
        )}
        <AgStudioProvider {...(LICENSE ? { licenseKey: LICENSE } : {})}>
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
            onApiReady={(e) => {
              studio.current = { key: layoutKey, api: e.api };
            }}
          />
        </AgStudioProvider>
      </div>
    </div>
  );
}
