import type { AgDataSourcesDefinition, AgFieldDefinition, AgGridWidget, AgReportState, AgTextWidget, AgValueWidget, AgWidgetLayoutState } from "ag-studio";
import { moneyIn, type Lang } from "../format";
import type { LedgerModel } from "./derive";
import { WORDS } from "./i18n";

// The report AG Studio renders: its data, its widgets and where they sit.
// Figures reach the value widgets and the book through Studio's data engine.

export const MAP_WIDGET = "ledger-map";
export const SHELTER_WIDGET = "ledger-shelter";
export const DONORS_WIDGET = "ledger-donors";
export const FOOTER_WIDGET = "ledger-footer";
export const NOTE_WIDGET = "ledger-note";
/** "The book" over the book, with the assistant's narrowing when there is one. */
export const BOOK_HEAD_WIDGET = "ledger-book-head";
/** The assistant's chat, right over the book, the whole width; only when the assistant gave a component. */
export const ASK_WIDGET = "ledger-ask";

const BOOK_WIDGET_ID = "book";
export const NOTE_WAITING = "note-waiting";
export const NOTE_REST = "note-rest";
const PAGE_ID = "ledger";
/** The book's columns, by field id. */
export const BOOK = {
  line: "book.line",
  item: "book.item",
  need: "book.needShown",
  payer: "book.payerLabel",
  paid: "book.paid",
  capture: "book.capture",
  status: "book.status",
  what: "book.what",
  who: "book.who",
  much: "book.much",
  state: "book.state",
} as const;
export const NEED_FIELD = BOOK.need;
export const WHAT_FIELD = BOOK.what;
export const ORDER_FIELD = "book.order";
/** Each row's ledger id: the cells find their row in the store by it. */
export const ROWKEY_FIELD = "book.rowKey";
/** In the query, off the screen. */
export const HIDDEN_FIELDS = [ORDER_FIELD, ROWKEY_FIELD];

/** Book rows are tall enough for a strip of the receipt over the line's name. */
export const BOOK_ROW_PX = 64;
/** A phone shows the receipt line in the band only: its rows stay short (cells.tsx WhatCell). */
export const PHONE_BOOK_ROW_PX = 48;

export const COLORS = { ink: "#1C1B19", muted: "#55595F", spent: "#2F855A", spentText: "#256F4B", back: "#0A74C9", held: "#B7791F", refused: "#D0294A" };

const moneyField = (id: string, name: string, currency: string, lang: Lang): AgFieldDefinition => ({
  id,
  name,
  format: "integerFormat",
  createValueFormatter: () => (v: number) => moneyIn(lang, currency, v),
});

const plusField = (id: string, name: string, currency: string, lang: Lang): AgFieldDefinition => ({
  id,
  name,
  format: "integerFormat",
  createValueFormatter: () => (v: number) => `+${moneyIn(lang, currency, v)}`,
});

const text = (id: string, name: string): AgFieldDefinition => ({ id, name, format: "textFormat" });

/** The two tables behind the screen: one row of totals, and every line of the book. */
export function ledgerData(m: LedgerModel, lang: Lang = m.lang ?? "en"): AgDataSourcesDefinition {
  const base = m.baseCurrency;
  const w = WORDS[lang];
  const h = w.head;
  return {
    sources: [
      {
        id: "totals",
        name: "Totals",
        data: [{ promised: m.promised, spent: m.spent, rest: m.rest, match: m.match }],
        fields: [moneyField("promised", w.pledged, base, lang), moneyField("spent", m.spentLabel, base, lang), moneyField("rest", m.restLabel, base, lang), plusField("match", w.companyMatch, base, lang)],
      },
      {
        id: "book",
        name: "Book",
        // Only the fields below: Studio's engine takes flat values, and the proof's data stays in the store.
        data: m.book.map((r) => ({
          order: r.order,
          rowKey: r.rowKey,
          lineKey: r.lineKey,
          line: r.line,
          item: r.item,
          need: r.need,
          needShown: r.needShown,
          payer: r.payer,
          payerLabel: r.payerLabel,
          share: r.share,
          paid: r.paid,
          charged: r.charged,
          capture: r.capture,
          status: r.status,
          what: r.what,
          who: r.who,
          // The phone's "How much": the payer's share in the payer's own currency, as the desktop Share column shows it.
          much: r.paid,
          state: r.state,
        })),
        fields: [
          { id: "order", name: "Order", format: "integerFormat" },
          text("rowKey", "Row"),
          text("lineKey", "Line key"),
          { id: "line", name: h.line, format: "integerFormat" },
          text("item", h.item),
          text("need", h.need),
          text("needShown", h.need),
          text("payer", h.payer),
          text("payerLabel", h.payer),
          moneyField("share", h.share, base, lang),
          text("paid", h.share),
          text("charged", h.charged),
          text("capture", h.capture),
          text("status", h.status),
          text("what", h.what),
          text("who", h.who),
          text("much", h.much),
          text("state", h.state),
        ],
      },
    ],
  };
}

export interface Metrics {
  /** Pixels per track on the page. */
  rowHeight: number;
  stacked: boolean;
  /** Screen scale, 1 at the 1440 × 900 reference. */
  scale: number;
  rows: { kpi: number; pair: number; match: number; note: number; map: number; shelter: number; donors: number; footer: number; ask: number; head: number; book: number };
}

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });

const SANS = "Inter, system-ui, sans-serif";

function kpi(title: string, field: string, color: string, valuePx: number, titlePx: number, align: "left" | "center"): AgValueWidget {
  return {
    type: "value",
    dataMapping: { value: [{ id: field, aggregation: "sum" }] },
    format: {
      title: { enabled: true, text: title, textAlign: align, color: "#3C4250", typography: { fontFamily: SANS, fontSize: titlePx, fontWeight: "normal" } },
      style: { color, textAlign: align, verticalAlign: "top", typography: { fontFamily: SANS, fontSize: valuePx, fontWeight: "bold" } },
      crossFilter: "none",
    },
  };
}

// Unaggregated columns are a GROUP BY, so two equal lines on two receipts would become one row.
// `order` is unique per row: it stays in the query and leaves the screen (see ORDER_FIELD).
// `rowKey` is unique too, and is how a cell finds its row in the store (cells.tsx).
const columns = (ids: string[]): { id: string; aggregation?: undefined }[] => [...ids, ORDER_FIELD, ROWKEY_FIELD].map((id) => ({ id }));
/** As PROOF-B: Line · Receipt line · Need · Payer · Share · PayPal capture · Status. */
const WIDE = columns([BOOK.line, BOOK.item, BOOK.need, BOOK.payer, BOOK.paid, BOOK.capture, BOOK.status]);
/** A phone has room for four questions: what, who, how much, status. */
const NARROW = columns([BOOK.what, BOOK.who, BOOK.much, BOOK.state]);

function book(stacked: boolean): AgGridWidget {
  return {
    type: "grid",
    dataMapping: { cols: stacked ? NARROW : WIDE },
    sort: [{ field: { id: ORDER_FIELD }, direction: "asc" }],
    format: {
      title: { enabled: false },
      style: { columnAutoSize: true, theme: { rowHeight: stacked ? PHONE_BOOK_ROW_PX : BOOK_ROW_PX } },
      crossFilter: "filter",
    },
  };
}

/** The page: three totals, the map and the shelter card, the bottom line, the assistant's chat, and the book. */
export function ledgerState(m: LedgerModel, x: Metrics, lang: Lang = m.lang ?? "en"): AgReportState {
  const w = WORDS[lang];
  const rest = m.phase === "closed" ? COLORS.back : COLORS.held;
  const r = x.rows;
  const s = x.scale;
  const widgets: Record<string, unknown> = {};
  const layout: Record<string, AgWidgetLayoutState> = {};
  const place = (id: string, widget: unknown, box: AgWidgetLayoutState) => {
    widgets[id] = widget;
    layout[id] = box;
  };

  const custom = (type: string, mapped?: object) => ({ type, dataMapping: mapped ?? {}, format: {} });
  const map = custom(MAP_WIDGET, { lineKey: [{ id: "book.lineKey" }] });

  const note = (id: string, box: AgWidgetLayoutState) => place(id, custom(NOTE_WIDGET), box);

  // 48 tracks: fine enough to centre the "+ company match … = … bought" line under the middle total.
  if (x.stacked) {
    place("kpi-promised", kpi(w.pledged, "totals.promised", COLORS.ink, 58, 21, "center"), at(0, 0, 48, r.kpi));
    place("kpi-spent", kpi(m.spentLabel, "totals.spent", COLORS.spent, 38, 16, "center"), at(0, r.kpi, 24, r.pair));
    place("kpi-rest", kpi(m.restTitle, "totals.rest", rest, 38, 16, "center"), at(24, r.kpi, 24, r.pair));
    let y = r.kpi + r.pair;
    if (r.note) {
      note(NOTE_WAITING, at(0, y, 24, r.note));
      note(NOTE_REST, at(24, y, 24, r.note));
      y += r.note;
    }
    if (m.plusMatch) {
      place("plus-match", plusMatch(15, m.plusMatch), at(0, y, 48, r.match));
      y += r.match;
    }
    place("map", map, at(0, y, 48, r.map));
    y += r.map;
    place("shelter", custom(SHELTER_WIDGET), at(0, y, 48, r.shelter));
    y += r.shelter;
    place("donors", custom(DONORS_WIDGET), at(0, y, 48, r.donors));
    y += r.donors;
    place("footer", custom(FOOTER_WIDGET), at(0, y, 48, r.footer));
    y += r.footer;
    if (r.ask) {
      place("ask", custom(ASK_WIDGET), at(0, y, 48, r.ask));
      y += r.ask;
    }
    place("book-head", custom(BOOK_HEAD_WIDGET), at(0, y, 48, r.head));
    y += r.head;
    place(BOOK_WIDGET_ID, book(true), at(0, y, 48, r.book));
  } else {
    const top = Math.round(74 * s);
    const label = Math.round(28 * s);
    const band = r.kpi - r.note;
    place("kpi-promised", kpi(w.pledged, "totals.promised", COLORS.ink, top, label, "center"), at(0, 0, 16, band));
    place("kpi-spent", kpi(m.spentLabel, "totals.spent", COLORS.spent, top, label, "center"), at(16, 0, 16, band - r.match));
    place("kpi-rest", kpi(m.restTitle, "totals.rest", rest, top, label, "center"), at(32, 0, 16, m.restNote ? band - r.match : band));
    if (m.plusMatch) place("plus-match", plusMatch(Math.round(19 * s), m.plusMatch), at(16, band - r.match, 16, r.match));
    if (m.restNote) note(NOTE_REST, at(32, band - r.match, 16, r.match));
    if (r.note) note(NOTE_WAITING, at(16, band, 16, r.note));
    place("map", map, at(0, r.kpi, 32, r.map));
    place("shelter", custom(SHELTER_WIDGET), at(32, r.kpi, 16, r.map));
    place("footer", custom(FOOTER_WIDGET), at(0, r.kpi + r.map, 48, r.footer));
    let y = r.kpi + r.map + r.footer;
    if (r.ask) {
      place("ask", custom(ASK_WIDGET), at(0, y, 48, r.ask));
      y += r.ask;
    }
    place("book-head", custom(BOOK_HEAD_WIDGET), at(0, y, 48, r.head));
    place(BOOK_WIDGET_ID, book(false), at(0, y + r.head, 48, r.book));
  }

  return {
    selectedPageId: PAGE_ID,
    pages: [{ id: PAGE_ID, widgets: widgets as AgReportState["pages"][number]["widgets"], widgetLayout: layout }],
  };
}

/**
 * "+ company match ¥X = ¥Y bought", under the donors' figure: one equation instead of a second "spent".
 * Studio's text widget; the figures are the model's (derive.ts), in the book's money format.
 */
function plusMatch(px: number, text: string): AgTextWidget {
  return {
    type: "text",
    dataMapping: {},
    format: { style: { text, textAlign: "center", verticalAlign: "center", color: "#3C4250", typography: { fontFamily: SANS, fontSize: px, fontWeight: "normal" } } },
  };
}
