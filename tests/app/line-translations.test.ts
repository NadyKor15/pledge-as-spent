import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openPglite } from "../../src/db/client";
import { lineTranslations, spendLedger } from "../../src/db/schema";
import { donorLang, parseTranslations, TRANSLATE_PREFIX } from "../../src/receipts/translate";
import { META_TRANSLATE_CAP_USD, PgMetaReadLedger } from "../../src/server/spend";
import { LineTranslator, TRANSLATE_RETRY_AFTER_MS, type RecordedTranslations } from "../../src/server/translations";
import type { DriveView } from "../../src/ui/types";

// The donor's statement lines in the donor's language (P1): recorded translations first (the showcase: no call), then
// the kept ones, then one Meta call per receipt and language inside the Meta reading's ceiling; English, said so,
// whenever that cannot be had. No live call: Meta is a fake fetch here.

const ROOT = path.resolve(__dirname, "../..");
const showcase = () => (JSON.parse(readFileSync(path.join(ROOT, "evidence/control-drive-20261109-810b24be50.json"), "utf8")) as { drive: DriveView }).drive;
const holdOf = (v: DriveView, name: string) => v.holds.find((h) => h.donorName.startsWith(name))!;
const rowsOf = (v: DriveView, name: string) => v.ledger.filter((r) => r.kind === "donor_share" && r.donorName?.startsWith(name)).map((r) => ({ receiptId: r.receiptId, lineNo: r.lineNo as number }));

async function db() {
  const h = await openPglite();
  await h.migrate(path.join(ROOT, "drizzle"));
  return h.db;
}

/** Meta answering every call with `answer(lines asked)`; counts the calls. */
function fakeMeta(answer: (asked: { n: number; printed: string }[]) => string, status = 200) {
  const calls: string[] = [];
  const fake = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.instructions as string);
    if (status !== 200) return new Response("busy", { status });
    const asked = JSON.parse(body.input[0].content[0].text).lines as { n: number; printed: string }[];
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: answer(asked) }] }], usage: { input_tokens: 400, output_tokens: 200 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch: fake, calls };
}
const german = (asked: { n: number }[]) => JSON.stringify({ lines: asked.map((a) => ({ n: a.n, t: `Zeile ${a.n} auf Deutsch` })) });
const none: RecordedTranslations = { lines: { de: {}, ja: {} } };

describe("the donor's language", () => {
  it("from the hold's country: Lena in Germany German, Yuki in Japan Japanese, Mark in the US English", () => {
    const v = showcase();
    expect([holdOf(v, "Lena").donorCountry, holdOf(v, "Yuki").donorCountry, holdOf(v, "Mark").donorCountry].map(donorLang)).toEqual(["de", "ja", "en"]);
    expect(donorLang("AT")).toBe("de");
    expect(donorLang(null)).toBe("en");
  });
});

describe("LineTranslator", () => {
  it("English donor: the reading's English, no call", async () => {
    const meta = fakeMeta(german);
    const t = new LineTranslator({ db: await db(), recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } });
    const v = showcase();
    const r = await t.forStatement(v, holdOf(v, "Mark").pledgeId, rowsOf(v, "Mark"));
    expect(r.lang).toBe("en");
    expect(r.lines.map((l) => [l.lineNo, l.text, l.source])).toEqual([
      [4, "Soft kids diapers M 44pcs", "english"],
      [5, "Baby pants diapers M", "english"],
      [6, "Paper diapers M trial pack", "english"],
    ]);
    expect(meta.calls).toHaveLength(0);
  });

  it("the showcase reads recorded translations: Lena's three lines in German, no call even with a key", async () => {
    const meta = fakeMeta(german);
    const recorded: RecordedTranslations = { lines: { de: { "北空の天然水 2L 6本ケース": "Kitasora-Naturwasser 2 l, 6er-Kiste", "雪解けの水 2L": "Schmelzwasser 2 l", "ミネラルウォーター 2Lペット": "Mineralwasser 2 l, PET" } } };
    const t = new LineTranslator({ db: await db(), recorded, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } });
    const v = showcase();
    const r = await t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect(r).toEqual({ lang: "de", unavailable: false, lines: expect.any(Array) });
    expect(r.lines.map((l) => [l.lineNo, l.source])).toEqual([
      [1, "recorded"],
      [2, "recorded"],
      [3, "recorded"],
    ]);
    expect(r.lines[0].text).toBe("Kitasora-Naturwasser 2 l, 6er-Kiste");
    expect(meta.calls).toHaveLength(0);
  });

  it("a live drive: one call for the receipt's lines, written to the ledger with the translate prefix and kept; the second time no call", async () => {
    const d = await db();
    const meta = fakeMeta(german);
    const t = new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } });
    const v = showcase();
    const first = await t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect(first.lines.map((l) => [l.lineNo, l.text, l.source])).toEqual([
      [1, "Zeile 1 auf Deutsch", "model"],
      [2, "Zeile 2 auf Deutsch", "model"],
      [3, "Zeile 3 auf Deutsch", "model"],
    ]);
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toContain("into German");
    const ledger = await d.query.spendLedger.findMany();
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(ledger.every((row) => row.what.startsWith(TRANSLATE_PREFIX))).toBe(true);
    expect(await new PgMetaReadLedger(d, 5).total()).toBeGreaterThan(0);
    expect(await d.select().from(lineTranslations)).toHaveLength(3);
    const again = await new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } }).forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect(again.lines.every((l) => l.source === "kept")).toBe(true);
    expect(meta.calls).toHaveLength(1);
  });

  it("two statements opening at once make one call", async () => {
    const meta = fakeMeta(german);
    const t = new LineTranslator({ db: await db(), recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } });
    const v = showcase();
    await Promise.all([t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena")), t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"))]);
    expect(meta.calls).toHaveLength(1);
  });

  it("the ceiling reached: no call, the lines stay in English, said so", async () => {
    const meta = fakeMeta(german);
    const t = new LineTranslator({ db: await db(), recorded: none, meta: { apiKey: "k", capUsd: 0.000001, fetch: meta.fetch } });
    const v = showcase();
    const r = await t.forStatement(v, holdOf(v, "Yuki").pledgeId, rowsOf(v, "Yuki"));
    expect(r.lang).toBe("ja");
    expect(r.unavailable).toBe(true);
    expect(r.lines.map((l) => [l.text, l.source])).toEqual([
      ["Alkaline AA batteries 20pk", "english"],
      ["AA batteries 10pk", "english"],
      ["AA battery loose", "english"],
    ]);
    expect(meta.calls).toHaveLength(0);
  });

  it("no key, Meta refusing, or an answer missing a line: English, said so, nothing kept", async () => {
    const v = showcase();
    const noKey = await new LineTranslator({ db: await db(), recorded: none }).forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect([noKey.unavailable, noKey.lines.every((l) => l.source === "english")]).toEqual([true, true]);
    const refusing = fakeMeta(german, 400);
    const d = await db();
    const r1 = await new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: refusing.fetch } }).forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect(r1.unavailable).toBe(true);
    const short = fakeMeta((asked) => JSON.stringify({ lines: asked.slice(1).map((a) => ({ n: a.n, t: "x" })) }));
    const r2 = await new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: short.fetch } }).forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect([r2.unavailable, r2.lines.every((l) => l.source === "english")]).toEqual([true, true]);
    expect(await d.select().from(lineTranslations)).toHaveLength(0);
  });
});

// A failed call is not kept in the table, and the statement asks on every open: without a stop each German or Japanese
// opening called Meta again and ate the reading's $5. Two stops: translations' own part of the ceiling ($0.50 of the
// `read-meta:translate:` rows, in the same ledger and lock), and no new call for the same receipt and language for ten
// minutes after a failure, in this instance. Meta is a fake fetch: no live call.
describe("translations never eat the reading's ceiling", () => {
  const seed = (d: Awaited<ReturnType<typeof db>>, what: string, usd: number) => d.insert(spendLedger).values({ id: `seed-${what}`, ts: "2026-11-10T00:00:00.000Z", kind: "reserve", what, usd: usd.toFixed(6), ref: null });

  it("a failure: the same statement opened again within ten minutes makes no call, English said so; after ten minutes, one", async () => {
    const refusing = fakeMeta(german, 400);
    let now = new Date("2026-11-10T08:00:00.000Z");
    const t = new LineTranslator({ db: await db(), recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: refusing.fetch }, now: () => now });
    const v = showcase();
    const open = () => t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    expect((await open()).unavailable).toBe(true);
    expect(refusing.calls).toHaveLength(1);
    now = new Date(now.getTime() + TRANSLATE_RETRY_AFTER_MS - 1);
    const again = await open();
    expect([again.unavailable, again.lines.every((l) => l.source === "english")]).toEqual([true, true]);
    expect(refusing.calls).toHaveLength(1);
    now = new Date(now.getTime() + 1);
    await open();
    expect(refusing.calls).toHaveLength(2);
  });

  it("a failure for one receipt or language stops only that one: Yuki's Japanese is still asked", async () => {
    const refusing = fakeMeta(german, 400);
    const t = new LineTranslator({ db: await db(), recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: refusing.fetch } });
    const v = showcase();
    await t.forStatement(v, holdOf(v, "Lena").pledgeId, rowsOf(v, "Lena"));
    await t.forStatement(v, holdOf(v, "Yuki").pledgeId, rowsOf(v, "Yuki"));
    expect(refusing.calls).toHaveLength(2);
  });

  it(`translations past their own $${META_TRANSLATE_CAP_USD.toFixed(2)}: no call, English said so, though the reading's $5 has room`, async () => {
    const d = await db();
    await seed(d, `${TRANSLATE_PREFIX}earlier (muse-spark)`, META_TRANSLATE_CAP_USD - 0.0001);
    const meta = fakeMeta(german);
    const r = await new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } }).forStatement(showcase(), holdOf(showcase(), "Lena").pledgeId, rowsOf(showcase(), "Lena"));
    expect(meta.calls).toHaveLength(0);
    expect([r.unavailable, r.lines.every((l) => l.source === "english")]).toEqual([true, true]);
    expect(await new PgMetaReadLedger(d, 5).total()).toBeLessThan(1);
  });

  it("the reading's own rows do not count against translations' part, and a reading is not stopped by it", async () => {
    const d = await db();
    await seed(d, "read-meta:receipt r-1 (muse-spark)", 2);
    const meta = fakeMeta(german);
    const r = await new LineTranslator({ db: d, recorded: none, meta: { apiKey: "k", capUsd: 5, fetch: meta.fetch } }).forStatement(showcase(), holdOf(showcase(), "Lena").pledgeId, rowsOf(showcase(), "Lena"));
    expect(meta.calls).toHaveLength(1);
    expect(r.unavailable).toBe(false);
    await seed(d, `${TRANSLATE_PREFIX}more`, META_TRANSLATE_CAP_USD);
    const ledger = new PgMetaReadLedger(d, 5, { prefix: TRANSLATE_PREFIX, capUsd: META_TRANSLATE_CAP_USD });
    await expect(ledger.reserve({ ts: "2026-11-10T09:00:00.000Z", id: "read-1", kind: "reserve", what: "read-meta:receipt r-2 (muse-spark)", usd: 0.1 }, 5)).resolves.toBeGreaterThan(2);
    await expect(ledger.reserve({ ts: "2026-11-10T09:00:00.000Z", id: "tr-1", kind: "reserve", what: `${TRANSLATE_PREFIX}r-2 de`, usd: 0.01 }, 5)).rejects.toThrow(/ceiling \$0\.50/);
  });
});

describe("parseTranslations", () => {
  const lines = [1, 2].map((n) => ({ lineNo: n, printed: `p${n}`, english: `e${n}` }));
  it("takes the JSON among the words, refuses a line not asked for, an empty one, or not JSON", () => {
    expect([...parseTranslations('Here: {"lines":[{"n":1,"t":"a"},{"n":2,"t":"b"}]}', lines)]).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(() => parseTranslations('{"lines":[{"n":1,"t":"a"},{"n":3,"t":"b"}]}', lines)).toThrow(/not asked/);
    expect(() => parseTranslations('{"lines":[{"n":1,"t":""},{"n":2,"t":"b"}]}', lines)).toThrow(/empty/);
    expect(() => parseTranslations("sorry", lines)).toThrow(/not JSON/);
  });
});
