import type { StatementView } from "../types";
import { STATUS_WORDS } from "./words";
import { zipStore } from "./zip";

// The donor's statement as an Excel workbook, written by hand: a handful of
// OOXML parts in an uncompressed zip. AG Grid's Excel export is Enterprise and
// outside the Studio licence, so this does not use it and adds no dependency.
// Money is a number in major units with a currency number format, so Excel can
// sum and sort it; PayPal ids are text, so they never turn into 3.2E+15.

type Cell = { v: string | number | null; s?: number };

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", JPY: "¥", GBP: "£", CAD: "CA$", AUD: "A$" };
const ZERO_DECIMAL = new Set(["JPY"]);
const decimals = (c: string) => (ZERO_DECIMAL.has(c) ? 0 : 2);
const major = (c: string, minor: number) => minor / 10 ** decimals(c);

/** Cell styles: indexes into cellXfs, in the order `stylesXml` writes them. */
const S = { plain: 0, title: 1, head: 2, text: 3, moneyA: 4, moneyB: 5, int: 6, date: 7, label: 8, moneyABold: 9, moneyBBold: 10 } as const;
const FIRST_CUSTOM_FMT = 164;
const DATE_FMT = 170;

/** Characters XML 1.0 cannot carry are dropped; the rest is escaped. */
function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel serial date (days since 1899-12-30, UTC) for an ISO instant; null when unparseable. */
function serial(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t / 86_400_000 + 25_569;
}

function cellXml(ref: string, c: Cell): string {
  const s = c.s ? ` s="${c.s}"` : "";
  if (c.v === null || c.v === "") return c.s ? `<c r="${ref}"${s}/>` : "";
  if (typeof c.v === "number") return `<c r="${ref}"${s}><v>${Number.isInteger(c.v) ? c.v : Number(c.v.toPrecision(15))}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
}

function moneyFmt(currency: string): string {
  const sym = SYMBOL[currency] ?? `${currency} `;
  return `&quot;${esc(sym)}&quot;#,##0${decimals(currency) ? ".00" : ""}`;
}

function stylesXml(pledgeCur: string, baseCur: string): string {
  const a = FIRST_CUSTOM_FMT;
  const b = FIRST_CUSTOM_FMT + 1;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="3"><numFmt numFmtId="${a}" formatCode="${moneyFmt(pledgeCur)}"/><numFmt numFmtId="${b}" formatCode="${moneyFmt(baseCur)}"/><numFmt numFmtId="${DATE_FMT}" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
    `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEE6"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF5B6B5A"/></bottom><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="11">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="${a}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="${b}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>` +
    `<xf numFmtId="${DATE_FMT}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="${a}" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>` +
    `<xf numFmtId="${b}" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

export interface XlsxOptions {
  /** Stamp on the sheet and the zip entries. Default: now. */
  generatedAt?: Date;
  /** The drive's name as the screens show it; the statement itself carries only the raw title. */
  driveTitle?: string;
}

/** The pledge id made safe for a file name on any system. */
export function statementFileName(v: StatementView): string {
  return `statement-${v.statement.pledgeId.replace(/[^A-Za-z0-9._-]+/g, "_")}.xlsx`;
}

export function buildStatementXlsx(view: StatementView, opts: XlsxOptions = {}): Uint8Array {
  const at = opts.generatedAt ?? new Date();
  const { statement: st, drive } = view;
  const cur = st.currency;
  const base = st.baseCurrency;
  const sameCurrency = cur === base;
  const rows: Cell[][] = [];

  rows.push([{ v: "Pledge-as-Spent — donor statement", s: S.title }]);
  const info = (label: string, v: string | number, s: number = S.plain): void => void rows.push([{ v: label, s: S.label }, { v, s }]);
  info("Drive", opts.driveTitle ?? drive.title);
  info("Donor", st.donorName);
  info("Pledge", st.pledgeId, S.text);
  info("Hold at PayPal", st.balance.authorizationId ?? "none yet", S.text);
  info("Pledge currency", cur);
  if (!sameCurrency) info("Drive currency", base);
  rows.push([
    { v: "Generated (UTC)", s: S.label },
    { v: serial(at.toISOString()), s: S.date },
  ]);
  rows.push([]);

  const head: string[] = ["Receipt", "Line", "Item", "Qty", "Unit", `Your share (${cur})`];
  if (!sameCurrency) head.push(`Your share (${base})`);
  head.push(`Match unlocked (${base})`, "Status", "PayPal capture ID", "Request ID", `Taken back (${cur})`, "Not collected because", "Date (UTC)");
  const headerRow = rows.length + 1;
  rows.push(head.map((v) => ({ v, s: S.head })));

  for (const r of st.rows) {
    const line: Cell[] = [
      { v: r.receiptId, s: S.text },
      { v: r.lineNo, s: S.int },
      { v: r.item },
      { v: r.qty, s: S.int },
      { v: r.unit },
      { v: major(cur, r.share.minor), s: S.moneyA },
    ];
    if (!sameCurrency) line.push({ v: major(base, r.shareBase), s: S.moneyB });
    line.push(
      { v: major(base, r.matchBase), s: S.moneyB },
      { v: STATUS_WORDS[r.status] ?? r.status },
      { v: r.captureId, s: S.text },
      { v: r.requestId, s: S.text },
      { v: r.reversed ? major(cur, r.reversed) : null, s: S.moneyA },
      { v: r.uncollectedReason },
      { v: serial(r.at), s: S.date },
    );
    rows.push(line);
  }
  const lastDataRow = rows.length;
  rows.push([]);

  rows.push([{ v: "Totals", s: S.label }]);
  const total = (label: string, minor: number, currency: string, bold = false): void => {
    const first = currency === cur;
    rows.push([
      { v: label, s: S.label },
      { v: major(currency, minor), s: bold ? (first ? S.moneyABold : S.moneyBBold) : first ? S.moneyA : S.moneyB },
    ]);
  };
  const b = st.balance;
  total("Pledged", b.pledged, cur, true);
  total("Charged", st.totals.charged, cur, true);
  total("Released at PayPal", b.released, cur);
  total("Taken back by PayPal after capture", st.totals.reversed, cur);
  total("Not collected", st.totals.uncollected, cur);
  total("Your shares, total", st.totals.share, cur);
  if (!sameCurrency) total("Your shares, total (drive currency)", st.totals.shareBase, base);
  total("Match unlocked", st.totals.matchBase, base);
  total("Help bought, total", st.totals.helpBase, base, true);

  const widths = sameCurrency ? [36, 20, 26, 8, 14, 16, 18, 28, 22, 30, 16, 24, 18] : [36, 20, 26, 8, 14, 16, 16, 18, 28, 22, 30, 16, 24, 18];
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const sheetRows = rows
    .map((cells, i) => {
      const body = cells.map((c, j) => cellXml(`${colName(j)}${i + 1}`, c)).join("");
      return body ? `<row r="${i + 1}">${body}</row>` : "";
    })
    .join("");
  const lastCol = colName(head.length - 1);
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${rows.length}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols>` +
    `<sheetData>${sheetRows}</sheetData>` +
    (st.rows.length ? `<autoFilter ref="A${headerRow}:${lastCol}${lastDataRow}"/>` : "") +
    `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;

  const NS = "http://schemas.openxmlformats.org/";
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
  const filter = st.rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Statement!$A$${headerRow}:$${lastCol}$${lastDataRow}</definedName></definedNames>` : "";
  const files: Record<string, string> = {
    "[Content_Types].xml": xml(
      `<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": xml(`<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(`<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets>${filter}</workbook>`),
    "xl/_rels/workbook.xml.rels": xml(
      `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${NS}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": stylesXml(cur, base),
    "xl/worksheets/sheet1.xml": sheet,
  };
  const enc = new TextEncoder();
  return zipStore(
    Object.entries(files).map(([name, text]) => ({ name, data: enc.encode(text) })),
    at,
  );
}
