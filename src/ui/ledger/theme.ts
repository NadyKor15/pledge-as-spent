import { studioTheme } from "ag-studio";

// Studio should read as part of the page: no frame, no shadows, the page's own
// background and type. Cards that need an edge draw it themselves in ledger.css.

const BG = "#FAF8F4";
const INK = "#1C1B19";
const LINE = "#E8E4DC";
const MUTED = "#55595F";
const SANS = "var(--sans)";

export const ledgerTheme = studioTheme.withParams({
  fontFamily: SANS,
  fontSize: 14,
  textColor: INK,
  foregroundColor: INK,
  subtleTextColor: MUTED,
  backgroundColor: BG,
  borderColor: LINE,
  accentColor: "#0E6E6A",
  rowHoverColor: "#F3EFE7",

  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: BG,
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: BG,
  studioCanvasPadding: 0,
  studioCanvasFontFamily: SANS,

  studioWidgetBackgroundColor: "transparent",
  studioWidgetBorder: false,
  studioWidgetBorderRadius: 0,
  studioWidgetPadding: 0,
  studioWidgetTitleFontFamily: SANS,
  studioWidgetSubtitleFontFamily: SANS,
  studioWidgetCaptionFontFamily: SANS,

  gridFontFamily: SANS,
  gridFontSize: 14,
  gridCellTextColor: INK,
  gridHeaderBackgroundColor: BG,
  gridHeaderTextColor: MUTED,
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 13,
  gridRowHeight: 38,
  gridRowBorder: { width: 1, color: LINE },
  gridHeaderRowBorder: { width: 1, color: LINE },
  gridRowHoverColor: "#F3EFE7",
  gridWrapperBorder: false,
});
