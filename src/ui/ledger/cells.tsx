"use client";

import type { AgWidgetField } from "ag-studio";
import type { GridApi, IRowNode } from "ag-grid-community";
import type { CustomCellRendererProps } from "ag-grid-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import type { LedgerBookRow } from "./derive";
import { WORDS } from "./i18n";
import { lineProof } from "./proof";
import { ProofBand } from "./ProofBand";
import type { LedgerStore } from "./store";
import { Strip } from "./Strip";
import { BOOK, HIDDEN_FIELDS, NEED_FIELD, ROWKEY_FIELD } from "./studio-state";

// The book's cells. Studio 3.0.0 hands a cell its own field only, so each cell finds its row in the store by the
// row's ledger id, a hidden column of the book (ROWKEY_FIELD). The first cell of a row (Line on a desktop, What on a
// phone) also marks the row: its proof band, the rows pushed down under the band, a flash, the assistant's narrowing.

// Share of the book's width and the least each column can do with. Studio's own auto-size gives
// the free room to Line and leaves the items just wide enough, then redoes it on every filter.
const COLUMNS: [id: string, share: number, least: number][] = [
  [BOOK.line, 0.05, 52],
  [BOOK.item, 0.26, 250],
  [BOOK.need, 0.13, 130],
  [BOOK.payer, 0.16, 160],
  [BOOK.paid, 0.08, 80],
  [BOOK.capture, 0.16, 190],
  [BOOK.status, 0.16, 150],
];

const PHONE_COLUMNS: typeof COLUMNS = [
  [BOOK.what, 0.37, 130],
  [BOOK.who, 0.19, 66],
  [BOOK.much, 0.24, 84],
  [BOOK.state, 0.2, 70],
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
    const shown = HIDDEN_FIELDS.filter((f) => api.getColumn(f)?.isVisible());
    if (shown.length) api.setColumnsVisible(shown, false);
  });
}

/** The row's ledger id: a hidden column of the book, so it is in the row's data. */
const rowKeyOf = (data: unknown) => (data as Record<string, unknown> | undefined)?.[ROWKEY_FIELD] as string | undefined;

function watchGrid(api: GridApi, grid: Element, store: LedgerStore) {
  if (listening.has(api)) return;
  listening.add(api);
  for (const event of ["storeRefreshed", "modelUpdated", "gridSizeChanged", "columnResized"] as const) api.addEventListener(event, () => holdColumns(api, grid));
  // A press anywhere on a row opens its proof; inside the band it does not (the band stops it).
  api.addEventListener("rowClicked", (e) => {
    // The grid hears the click before React does: a press inside the band is the band's.
    if ((e.event?.target as Element | null)?.closest?.(".lg-band")) return;
    const key = rowKeyOf(e.data);
    if (key) store.toggleProof(key);
  });
  api.addEventListener("cellKeyDown", (e) => {
    const ev = e.event as KeyboardEvent | null | undefined;
    if (!ev || (ev.key !== "Enter" && ev.key !== " ")) return;
    if ((ev.target as Element | null)?.closest?.(".lg-band")) return;
    const key = rowKeyOf(e.data);
    if (!key) return;
    ev.preventDefault();
    store.toggleProof(key);
  });
}

function useSnap(store: LedgerStore) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

function useRow(store: LedgerStore, data: unknown): LedgerBookRow | undefined {
  const snap = useSnap(store);
  const key = rowKeyOf(data);
  return useMemo(() => snap.model.book.find((r) => r.rowKey === key), [snap.model, key]);
}

function useHold(api: GridApi, eGridCell: HTMLElement, store: LedgerStore) {
  useEffect(() => {
    // The grid's root, not this cell: the cell leaves the page with the next filter, the root stays.
    const grid = eGridCell.closest(".ag-root-wrapper");
    if (!grid) return;
    watchGrid(api, grid, store);
    holdColumns(api, grid);
  });
}

/** The displayed index of the row whose proof is open, or -1. */
function proofIndex(api: GridApi, proof: string | null): number {
  if (!proof) return -1;
  for (let i = 0; i < api.getDisplayedRowCount(); i++) if (rowKeyOf(api.getDisplayedRowAtIndex(i)?.data) === proof) return i;
  return -1;
}

/**
 * Marks the row this cell starts: open proof, pushed under a band, flashing, narrowed. Studio rebuilds a row whose
 * values change, so each mark is set again on the row element of the moment.
 */
function useRowMarks(api: GridApi, node: IRowNode, eGridCell: HTMLElement, store: LedgerStore, row: LedgerBookRow | undefined) {
  const snap = useSnap(store);
  const flash = row ? snap.flashes.get(row.rowKey) : undefined;
  const at = proofIndex(api, snap.proof);
  const index = node.rowIndex ?? -1;
  const open = Boolean(row && snap.proof === row.rowKey && at >= 0);
  const below = at >= 0 && index > at;
  const focused = Boolean(row && snap.focus?.lineKeys.includes(row.lineKey));
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = eGridCell.closest(".ag-row");
    if (!el) return;
    el.classList.toggle("lg-proof-row", open);
    el.classList.toggle("lg-below", below);
    el.classList.toggle("lg-focused", focused);
    el.classList.toggle("lg-flash-spent", flash?.kind === "spent");
    el.classList.toggle("lg-flash-back", flash?.kind === "back");
    if (flash && last.current !== flash.id) {
      last.current = flash.id;
      // A new change on the same element starts the flash over.
      for (const a of el.getAnimations()) if ((a as CSSAnimation).animationName?.startsWith("lg-flash")) a.currentTime = 0;
    }
    if (!flash) last.current = null;
    return () => {
      el.classList.remove("lg-proof-row", "lg-below", "lg-focused", "lg-flash-spent", "lg-flash-back");
    };
  }, [eGridCell, open, below, focused, flash]);
  return open;
}

/** The row's width, for a band as wide as the book. */
function useRowWidth(eGridCell: HTMLElement, on: boolean) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!on) return;
    const row = eGridCell.closest(".ag-row") as HTMLElement | null;
    const viewport = eGridCell.closest(".ag-center-cols-viewport") as HTMLElement | null;
    const el = viewport ?? row;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [eGridCell, on]);
  return width;
}

/** The cell's own width, kept up to date: the columns are set to their shares after the first paint. */
function useCellWidth(eGridCell: HTMLElement) {
  const [width, setWidth] = useState(() => eGridCell.clientWidth);
  useLayoutEffect(() => {
    const read = () => setWidth(eGridCell.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(eGridCell);
    return () => ro.disconnect();
  }, [eGridCell]);
  return width;
}

function Band({ store, row, stacked, width }: { store: LedgerStore; row: LedgerBookRow; stacked: boolean; width: number }) {
  const snap = useSnap(store);
  const proof = snap.view ? lineProof(snap.view, snap.model, row.rowKey, snap.lang) : null;
  if (!proof || !width) return null;
  return (
    <div className="lg-band-wrap" style={{ width }}>
      <ProofBand proof={proof} store={store} stacked={stacked} lang={snap.lang} ask={snap.askAbout} />
    </div>
  );
}

/** The receipt line: its printed strip from the published photo, the name under it. No box, no strip. */
function ItemStrip({ store, row, maxW, maxH }: { store: LedgerStore; row: LedgerBookRow; maxW: number; maxH: number }) {
  const snap = useSnap(store);
  const receipt = snap.view?.receipts.find((r) => r.id === row.receipt);
  const line = receipt?.lines.find((l) => l.lineNo === row.line);
  const url = receipt?.image.published && "url" in receipt.image ? receipt.image.url : undefined;
  if (!url || !url.startsWith("/") || !line?.box) return null;
  return <Strip url={url} box={line.box} maxW={maxW} maxH={maxH} label={line.text} />;
}

/** The cells of one store's book, by field. */
export function bookCells(store: LedgerStore): (field: AgWidgetField) => ComponentType<CustomCellRendererProps> | undefined {
  function LineCell({ api, node, eGridCell, data, value }: CustomCellRendererProps) {
    const row = useRow(store, data);
    useHold(api, eGridCell, store);
    const open = useRowMarks(api, node, eGridCell, store, row);
    const width = useRowWidth(eGridCell, open);
    return (
      <>
        <span className="lg-line-no" data-row-key={row?.rowKey}>
          {String(value ?? "")}
        </span>
        {open && row && <Band store={store} row={row} stacked={false} width={width} />}
      </>
    );
  }

  function ItemCell({ api, eGridCell, data, value }: CustomCellRendererProps) {
    const row = useRow(store, data);
    useHold(api, eGridCell, store);
    const column = useCellWidth(eGridCell) || 300;
    return (
      <span className="lg-item">
        {row && <ItemStrip store={store} row={row} maxW={Math.max(120, column - 24)} maxH={24} />}
        <span className="lg-item-name">{String(value ?? "")}</span>
      </span>
    );
  }

  /** The grid widget is flat, so a group shows as its first row: the need in bold, then its other lines. */
  function NeedCell({ api, node, column, value, eGridCell }: CustomCellRendererProps) {
    const above = node.rowIndex ? api.getDisplayedRowAtIndex(node.rowIndex - 1) : undefined;
    const first = !above || !column || above.data?.[column.getColId()] !== value;
    useHold(api, eGridCell, store);
    // Refused lines have no need: their dash is not a group's name.
    return <span className={first && value !== "—" ? "lg-group" : "lg-group-more"}>{String(value ?? "")}</span>;
  }

  function CaptureCell({ value, data }: CustomCellRendererProps) {
    const row = useRow(store, data);
    const w = WORDS[useSnap(store).lang];
    const id = String(value ?? "");
    if (id === "—") {
      const none = row?.kind === "rejected" || row?.kind === "unfunded";
      return <span className="lg-mono lg-faint">{none ? w.noCapture : "—"}</span>;
    }
    return (
      <span className="lg-capture">
        <span className="lg-cap-label">{w.paypalCapture}</span>
        <span className="lg-mono">{id}</span>
      </span>
    );
  }

  const tone = (code: string | undefined) =>
    code === "captured" ? "spent" : code === "rejected" || code === "unfunded" ? "refused" : code === "reversed" || code === "partly_reversed" || code === "uncollected" ? "back" : "waiting";

  function StatusCell({ value, data }: CustomCellRendererProps) {
    const row = useRow(store, data);
    return (
      <span className="lg-status">
        <span className={`lg-pill-status lg-tone-${tone(row?.code)}`}>{String(value ?? "")}</span>
        {row?.reason && <span className="lg-reason">{row.reason.replace(/\.$/, "")}</span>}
      </span>
    );
  }

  /**
   * The phone's first column: the line's short name; it also marks the row and holds the columns. A strip as narrow
   * as this column would be a grey sliver, so on a phone the receipt line shows only in the band, at a readable size.
   */
  function WhatCell({ api, node, eGridCell, data, value }: CustomCellRendererProps) {
    const row = useRow(store, data);
    useHold(api, eGridCell, store);
    const open = useRowMarks(api, node, eGridCell, store, row);
    const width = useRowWidth(eGridCell, open);
    return (
      <>
        <span className="lg-item-name lg-what-name" data-row-key={row?.rowKey}>
          {String(value ?? "")}
        </span>
        {open && row && <Band store={store} row={row} stacked width={width} />}
      </>
    );
  }

  function StateCell({ value, data }: CustomCellRendererProps) {
    const row = useRow(store, data);
    return <span className={`lg-pill-status lg-tone-${tone(row?.code)}`}>{String(value ?? "")}</span>;
  }

  const byField: Record<string, ComponentType<CustomCellRendererProps>> = {
    [BOOK.line]: LineCell,
    [BOOK.item]: ItemCell,
    [BOOK.need]: NeedCell,
    [BOOK.capture]: CaptureCell,
    [BOOK.status]: StatusCell,
    [BOOK.what]: WhatCell,
    [BOOK.state]: StateCell,
  };
  return (f) => byField[f.fieldId];
}
