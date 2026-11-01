import type { AgDataSourcesDefinition, AgFieldDefinition, AgGridWidget, AgReportState, AgTextWidget, AgValueWidget, AgWidgetLayoutState } from "ag-studio";
import { money } from "../format";
import type { LedgerModel } from "./derive";

// The report AG Studio renders: its data, its widgets and where they sit.
// Figures reach the value widgets and the book through Studio's data engine.

export const MAP_WIDGET = "ledger-map";
export const SHELTER_WIDGET = "ledger-shelter";
export const DONORS_WIDGET = "ledger-donors";
export const FOOTER_WIDGET = "ledger-footer";
export const NOTE_WIDGET = "ledger-note";

const BOOK_WIDGET_ID = "book";
export const NOTE_WAITING = "note-waiting";
export const NOTE_REST = "note-rest";
const PAGE_ID = "ledger";
export const NEED_FIELD = "book.need";
export const ORDER_FIELD = "book.order";

export const COLORS = { ink: "#1C1B19", muted: "#55595F", spent: "#2F855A", spentText: "#256F4B", back: "#0A74C9", held: "#B7791F", refused: "#D0294A" };

const moneyField = (id: string, name: string, currency: string): AgFieldDefinition => ({
  id,
  name,
  format: "integerFormat",
  createValueFormatter: () => (v: number) => money(currency, v),
});

const plusField = (id: string, name: string, currency: string): AgFieldDefinition => ({
  id,
  name,
  format: "integerFormat",
  createValueFormatter: () => (v: number) => `+${money(currency, v)}`,
});

const text = (id: string, name: string): AgFieldDefinition => ({ id, name, format: "textFormat" });

/** The two tables behind the screen: one row of totals, and every line of the book. */
export function ledgerData(m: LedgerModel): AgDataSourcesDefinition {
  const base = m.baseCurrency;
  return {
    sources: [
      {
        id: "totals",
        name: "Totals",
        data: [{ promised: m.promised, spent: m.spent, rest: m.rest, match: m.match }],
        fields: [moneyField("promised", "Promised", base), moneyField("spent", "Spent on needs", base), moneyField("rest", m.restLabel, base), plusField("match", "Company match", base)],
      },
      {
        id: "book",
        name: "Book",
        data: m.book.map((r) => ({ ...r })),
        fields: [
          { id: "order", name: "Order", format: "integerFormat" },
          text("lineKey", "Line key"),
          { id: "line", name: "Line", format: "integerFormat" },
          text("item", "Item"),
          text("need", "Need"),
          text("payer", "Payer"),
          moneyField("share", "Share", base),
          text("charged", "Charged"),
          text("capture", "PayPal capture"),
          text("status", "Status"),
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
  rows: { kpi: number; pair: number; match: number; note: number; map: number; shelter: number; donors: number; footer: number; book: number };
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
const COLUMNS: { id: string; aggregation?: undefined }[] = ["line", "item", "need", "payer", "share", "charged", "capture", "status", "order"].map((c) => ({ id: `book.${c}` }));

function book(): AgGridWidget {
  return {
    type: "grid",
    dataMapping: { cols: COLUMNS },
    sort: [{ field: { id: ORDER_FIELD }, direction: "asc" }],
    format: {
      title: { enabled: false },
      style: { columnAutoSize: true },
      crossFilter: "filter",
    },
  };
}

/** The page: three totals, the map and the shelter card, the bottom line, and under them the book. */
export function ledgerState(m: LedgerModel, x: Metrics): AgReportState {
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

  // 48 tracks: fine enough to centre the "Company match" pair under the middle total.
  if (x.stacked) {
    place("kpi-promised", kpi("Promised", "totals.promised", COLORS.ink, 58, 21, "center"), at(0, 0, 48, r.kpi));
    place("kpi-spent", kpi("Spent on needs", "totals.spent", COLORS.spent, 38, 16, "center"), at(0, r.kpi, 24, r.pair));
    place("kpi-rest", kpi(m.restLabel, "totals.rest", rest, 38, 16, "center"), at(24, r.kpi, 24, r.pair));
    let y = r.kpi + r.pair;
    if (r.note) {
      note(NOTE_WAITING, at(0, y, 24, r.note));
      note(NOTE_REST, at(24, y, 24, r.note));
      y += r.note;
    }
    if (m.matchName) {
      place("match-label", matchLabel(15), at(0, y, 25, r.match));
      place("kpi-match", matchValue(15), at(25, y, 23, r.match));
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
    place(BOOK_WIDGET_ID, book(), at(0, y, 48, r.book));
  } else {
    const top = Math.round(74 * s);
    const label = Math.round(28 * s);
    const small = Math.round(21 * s);
    const band = r.kpi - r.note;
    place("kpi-promised", kpi("Promised", "totals.promised", COLORS.ink, top, label, "center"), at(0, 0, 16, band));
    place("kpi-spent", kpi("Spent on needs", "totals.spent", COLORS.spent, top, label, "center"), at(16, 0, 16, band - r.match));
    place("kpi-rest", kpi(m.restLabel, "totals.rest", rest, top, label, "center"), at(32, 0, 16, m.restNote ? band - r.match : band));
    if (m.matchName) {
      place("match-label", matchLabel(small), at(16, band - r.match, 10, r.match));
      place("kpi-match", matchValue(small), at(26, band - r.match, 6, r.match));
    }
    if (m.restNote) note(NOTE_REST, at(32, band - r.match, 16, r.match));
    if (r.note) note(NOTE_WAITING, at(16, band, 16, r.note));
    place("map", map, at(0, r.kpi, 32, r.map));
    place("shelter", custom(SHELTER_WIDGET), at(32, r.kpi, 16, r.map));
    place("footer", custom(FOOTER_WIDGET), at(0, r.kpi + r.map, 48, r.footer));
    place(BOOK_WIDGET_ID, book(), at(0, r.kpi + r.map + r.footer, 48, r.book));
  }

  return {
    selectedPageId: PAGE_ID,
    pages: [{ id: PAGE_ID, widgets: widgets as AgReportState["pages"][number]["widgets"], widgetLayout: layout }],
  };
}

/** "Company match" and its figure, side by side: Studio's text widget beside a value widget. */
function matchLabel(px: number): AgTextWidget {
  return {
    type: "text",
    dataMapping: {},
    format: { style: { text: "Company match", textAlign: "right", verticalAlign: "center", color: "#4A5160", typography: { fontFamily: SANS, fontSize: px, fontWeight: "normal" } } },
  };
}

function matchValue(px: number): AgValueWidget {
  return {
    type: "value",
    dataMapping: { value: [{ id: "totals.match", aggregation: "sum" }] },
    format: { style: { color: COLORS.spentText, textAlign: "left", verticalAlign: "center", typography: { fontFamily: SANS, fontSize: px, fontWeight: "bold" } }, crossFilter: "none" },
  };
}
