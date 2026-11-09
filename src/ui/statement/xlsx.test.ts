import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lenaStatement } from "../../../tests/fixtures/statement/lena";
import { buildStatementXlsx, statementFileName } from "./xlsx";
import { readZip } from "./zip";

const GENERATED = new Date("2026-11-06T12:00:00Z");
const bytes = buildStatementXlsx(lenaStatement, { generatedAt: GENERATED });
const parts = new Map(readZip(bytes).map((f) => [f.name, new TextDecoder().decode(f.data)]));
const sheet = parts.get("xl/worksheets/sheet1.xml")!;

const python = spawnSync("python3", ["-c", "import openpyxl"]);
const haveOpenpyxl = python.status === 0;

describe("buildStatementXlsx: the package", () => {
  it("has the five parts Excel needs, every CRC intact", () => {
    expect([...parts.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort());
    expect(readZip(bytes).every((f) => f.crcOk && f.method === 0)).toBe(true);
    expect(parts.get("[Content_Types].xml")).toContain("spreadsheetml.sheet.main+xml");
  });

  it("starts with a zip signature and the content-types part first (some readers sniff it)", () => {
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(readZip(bytes)[0].name).toBe("[Content_Types].xml");
  });

  it("is deterministic for the same input and time", () => {
    expect(Buffer.from(buildStatementXlsx(lenaStatement, { generatedAt: GENERATED })).equals(Buffer.from(bytes))).toBe(true);
  });

  it("escapes markup in names and refuses control characters", () => {
    expect(sheet).toContain("Lena (Berlin) &amp; &quot;Partners&quot; &lt;GmbH&gt;");
    expect(sheet).not.toContain("<GmbH>");
    const dirty = structuredClone(lenaStatement);
    dirty.statement.donorName = "A\u0000B\u000bC\u{1F600}";
    const s = new TextDecoder().decode(readZip(buildStatementXlsx(dirty, { generatedAt: GENERATED })).find((f) => f.name === "xl/worksheets/sheet1.xml")!.data);
    expect(s).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(s).toContain("ABC\u{1F600}");
  });

  it("takes the drive's display title when given", () => {
    const t = buildStatementXlsx(lenaStatement, { generatedAt: GENERATED, driveTitle: "Kitasora Community Shelter — Earthquake relief" });
    const x = new TextDecoder().decode(readZip(t).find((f) => f.name === "xl/worksheets/sheet1.xml")!.data);
    expect(x).toContain("Kitasora Community Shelter — Earthquake relief");
  });

  it("keeps a formula-looking item as text, never as a formula", () => {
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("=HYPERLINK(&quot;http://evil.example&quot;)");
  });
});

describe("buildStatementXlsx: the numbers", () => {
  const cells = (): Map<string, { t?: string; s?: string; v: string }> => {
    const out = new Map<string, { t?: string; s?: string; v: string }>();
    for (const m of sheet.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/g)) {
      const attrs = m[2];
      const body = m[3] ?? "";
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      const s = /s="(\d+)"/.exec(attrs)?.[1];
      const v = t === "inlineStr" ? (/<t[^>]*>(.*?)<\/t>/s.exec(body)?.[1] ?? "") : (/<v>(.*?)<\/v>/.exec(body)?.[1] ?? "");
      out.set(m[1], { t, s, v });
    }
    return out;
  };

  it("writes money as numbers in major units, PayPal ids as text", () => {
    const c = cells();
    const header = [...c.entries()].filter(([, x]) => x.v === "PayPal capture ID").map(([k]) => k)[0];
    expect(header).toBeTruthy();
    const col = header.replace(/\d+/g, "");
    const headRow = Number(header.replace(/\D+/g, ""));
    // first data row is the first captured share: EUR 2.46
    const shareHeader = [...c.entries()].find(([k, x]) => k.endsWith(String(headRow)) && x.v === "Your share (EUR)")![0];
    const shareCol = shareHeader.replace(/\d+/g, "");
    expect(c.get(`${shareCol}${headRow + 1}`)).toMatchObject({ v: "2.46" });
    expect(c.get(`${shareCol}${headRow + 1}`)?.t).toBeUndefined();
    expect(c.get(`${col}${headRow + 1}`)).toMatchObject({ t: "inlineStr", s: "3", v: "3WP65983GD053501C" });
    // the base-currency yen column has no decimals
    const baseHeader = [...c.entries()].find(([k, x]) => k.endsWith(String(headRow)) && x.v === "Your share (JPY)")![0];
    expect(c.get(`${baseHeader.replace(/\d+/g, "")}${headRow + 1}`)).toMatchObject({ v: "399" });
  });

  it("carries the hold id and PayPal's capture ids, and none of the app's request ids", () => {
    expect(sheet).toContain("2Y816602392541815");
    expect(sheet).toContain("3WP65983GD053501C");
    expect(sheet).toContain("hold_expired");
    expect(lenaStatement.statement.rows.some((r) => r.requestId)).toBe(true);
    for (const r of lenaStatement.statement.rows) if (r.requestId) expect(sheet).not.toContain(r.requestId);
    expect(sheet).not.toContain("Request ID");
  });

  it.skipIf(!haveOpenpyxl)("opens in openpyxl: sums match the statement", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "xlsx-test-"));
    const file = path.join(dir, "s.xlsx");
    writeFileSync(file, bytes);
    const script = `
import json, sys, zipfile
from xml.etree import ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for n in z.namelist(): ET.fromstring(z.read(n))
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
rows = [[c.value for c in r] for r in ws.iter_rows()]
print(json.dumps({"rows": rows, "title": ws.title, "fmt": [[c.number_format for c in r] for r in ws.iter_rows()]}, default=str))
`;
    const out = JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8", cwd: dir }));
    const rows: (string | number | null)[][] = out.rows;
    const head = rows.findIndex((r) => r.includes("PayPal capture ID"));
    const idx = (name: string) => rows[head].indexOf(name);
    const data = rows.slice(head + 1, head + 1 + lenaStatement.statement.rows.length);
    expect(data).toHaveLength(6);
    const shares = data.map((r) => r[idx("Your share (EUR)")] as number);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(lenaStatement.statement.totals.share / 100, 10);
    expect(data.map((r) => r[idx("PayPal capture ID")])).toEqual(["3WP65983GD053501C", "3WP65983GD053501C", "3WP65983GD053501C", null, null, null]);
    expect(data.map((r) => typeof r[idx("PayPal capture ID")])).not.toContain("number");
    expect(rows[head]).not.toContain("Request ID");
    const find = (label: string) => rows.find((r) => r[0] === label);
    expect(find("Charged")?.[1]).toBeCloseTo(lenaStatement.statement.totals.charged / 100, 10);
    expect(find("Pledged")?.[1]).toBeCloseTo(20, 10);
    expect(find("Taken back by PayPal after capture")?.[1]).toBeCloseTo(0.3, 10);
    expect(find("Not collected")?.[1]).toBeCloseTo(1.2, 10);
    // currency formats are real number formats, so Excel sums and sorts them
    const fmtRow = out.fmt[head + 1];
    expect(fmtRow[idx("Your share (EUR)")]).toContain("€");
    expect(fmtRow[idx("Your share (JPY)")]).toContain("¥");
  });
});

describe("statementFileName", () => {
  it("is ascii-safe and carries the pledge id", () => {
    expect(statementFileName(lenaStatement)).toBe("statement-demo-f372326129.water.xlsx");
    const odd = structuredClone(lenaStatement);
    odd.statement.pledgeId = "../a b/ü";
    expect(statementFileName(odd)).toMatch(/^statement-[A-Za-z0-9._-]+\.xlsx$/);
  });
});
