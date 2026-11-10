import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { answerStarter } from "../../src/agent/starters";
import { donorFigures, findHolds, ledgerDonorMoney, ledgerFindDonor, ledgerPaypalIds, ledgerTotals } from "../../src/agent/tools";
import { toBase } from "../../src/core";
import { receiptCounts } from "../../src/server/telegram";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { lineViews, refusalSummary, shareGroups } from "../../src/ui/derive";
import { DonorView } from "../../src/ui/DonorView";
import { METER_KEYS } from "../../src/ui/hold-meter";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { journalOf } from "../../src/ui/ledger/journal";
import { needMeter } from "../../src/ui/ledger/need-meter";
import { chainMeter, chainOf, chainRows, chainStory, statementTarget } from "../../src/ui/statement/chain";
import { statementLines } from "../../src/ui/statement/lines";
import { renewedDrive, type RenewedDrive, type RenewedStage } from "./support/renewal-fixture";

// Every reader of a drive with ONE renewed donor, on the view and the statement the real service makes
// (support/renewal-fixture.ts: fake sandbox, PGlite, RENEW on), at each stage of Lena's chain. Lena pledged €20.00
// once; her renewal holds the same rest again, so a reader that adds her two holds counts her rest twice or calls
// her first hold's carried rest "never charged". Each reader must show her once, at her first hold's amount.

vi.setConfig({ testTimeout: 60_000 });
// The donor screen's pledge form asks for the app router, which a render outside Next does not mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

const STAGES: RenewedStage[] = ["renewed", "captured", "closed", "race"];

/** Lena's chain as one bar, in euro cents: what the core counts (charged, held, never charged); the race's surplus is no part of it. */
const WANT: Record<RenewedStage, { charged: number; held: number; never: number; lines: number }> = {
  renewed: { charged: 333, held: 1667, never: 0, lines: 1 },
  captured: { charged: 666, held: 1334, never: 0, lines: 2 },
  closed: { charged: 666, held: 0, never: 1334, lines: 2 },
  race: { charged: 333, held: 1667, never: 0, lines: 1 },
};

const drives = new Map<RenewedStage, RenewedDrive>();
beforeAll(async () => {
  for (const stage of STAGES) drives.set(stage, await renewedDrive(stage, `demo-readers-${stage}`));
});
const get = (stage: RenewedStage) => drives.get(stage)!;
const eur = (minor: number) => `€${(minor / 100).toFixed(2)}`;
/** Lena's donor rows in the book, from either hold of her chain. */
const lenaShares = (f: RenewedDrive) => f.view.ledger.filter((r) => r.kind === "donor_share" && (r.pledgeId === f.lena || r.pledgeId === f.renewal));

describe("the fixture: two holds for Lena, as the service writes them", () => {
  for (const stage of STAGES) {
    it(`${stage}: the old hold voided and linked to the renewal; Lena's shares as the stage has them`, () => {
      const f = get(stage);
      expect(f.view.features.renew).toBe(true);
      expect(f.view.holds.find((h) => h.pledgeId === f.lena)).toMatchObject({ status: "voided", renewedTo: f.renewal, authorized: 2000 });
      expect(f.view.holds.find((h) => h.pledgeId === f.renewal)).toMatchObject({ renews: f.lena });
      expect(lenaShares(f)).toHaveLength(WANT[stage].lines);
    });
  }
});

describe("the book (Ledger): Lena is one donor", () => {
  for (const stage of STAGES) {
    it(`${stage}: one row at her first hold's id and €20.00; her parts ${JSON.stringify(WANT[stage])}`, () => {
      const f = get(stage);
      const m = deriveLedger(f.view);
      expect(m.donors).toHaveLength(3);
      const lena = m.donors.filter((d) => d.name === "Lena");
      expect(lena).toHaveLength(1);
      const d = lena[0];
      expect(d.pledgeId).toBe(f.lena);
      const p = d.meter!;
      expect(p.total).toBe(2000);
      expect(METER_KEYS.reduce((a, k) => a + p[k], 0)).toBe(2000);
      expect({ charged: p.charged, waiting: p.waiting, held: p.held, returning: p.returning, never: p.never, back: p.back }).toEqual({ charged: WANT[stage].charged, waiting: 0, held: WANT[stage].held, returning: 0, never: WANT[stage].never, back: 0 });
      expect(d.spent).toBe(WANT[stage].charged);
      // never charged only once her chain is over; her first hold's carried rest is not
      expect(d.neverCharged).toBe(stage === "closed");
      expect(stage === "closed" ? d.back : d.held).toBe(2000 - WANT[stage].charged);
      expect(d.words?.rest).toBe(stage === "closed" ? "never charged" : "held");
      // her pledge in the drive's yen is her first hold's €20.00 at its rate, once
      const root = f.view.holds.find((h) => h.pledgeId === f.lena)!;
      expect(d.pledgedBase).toBe(toBase(2000, root.fx!, "floor"));
      expect(m.promised).toBe(m.spent + m.held + m.returned);
      expect(d.spentBase).toBe(lenaShares(f).reduce((a, r) => a + r.base, 0));
      // the need and the book's rows point at her one row
      expect(m.needs.find((n) => n.needId === "water")!.pledgeIds).toEqual([f.lena]);
      const rows = m.book.filter((r) => r.kind === "donor_share" && r.payer.startsWith("Lena"));
      expect(rows).toHaveLength(WANT[stage].lines);
      expect(rows.every((r) => r.pledgeId === f.lena)).toBe(true);
    });

    it(`${stage}: the water bar holds her rest once`, () => {
      const f = get(stage);
      const m = deriveLedger(f.view);
      const d = m.donors.find((x) => x.pledgeId === f.lena)!;
      const w = needMeter(f.view, "water", m);
      expect(w.promisedBy.filter((x) => x.startsWith("Lena"))).toHaveLength(stage === "closed" ? 0 : 1);
      expect(w.promised + w.returning + w.never + w.back).toBe(d.heldBase + d.backBase);
    });

    it(`${stage}: the PayPal journal says her first hold's rest carried on to a new hold, never "never charged"`, () => {
      const f = get(stage);
      const j = journalOf(f.view, deriveLedger(f.view));
      const voids = j.events.filter((e) => e.kind === "void" && e.pledgeId === f.lena);
      const carried = voids.filter((e) => e.text === "Lena · rest carried on to a new hold");
      expect(carried).toHaveLength(1);
      expect(carried[0]).toMatchObject({ group: "holds", never: false, donor: true });
      const never = voids.filter((e) => e.never);
      // only the end of the whole chain (the drive closed, her renewal voided) is never charged
      expect(never.map((e) => e.text)).toEqual(stage === "closed" ? ["Lena · rest never charged"] : []);
      expect(j.events.filter((e) => e.pledgeId === f.renewal)).toHaveLength(0);
    });
  }
});

/** The two screens as the server renders them. */
function screens(f: RenewedDrive) {
  const live = { following: false, refresh: async () => undefined, follow: () => undefined };
  return {
    coordinator: renderToStaticMarkup(createElement(CoordinatorView, { view: f.view, ...live })),
    donor: renderToStaticMarkup(createElement(DonorView, { view: f.view, role: "donor" })),
  };
}
/** The card of the hold `id` (each card carries data-flow="hold:<id>"), up to the next card. */
const cards = (html: string, id: string) => html.split('data-flow="hold:').filter((c) => c.startsWith(`${id}"`));

describe("the Coordinator and Donor screens: one card for Lena", () => {
  for (const stage of STAGES) {
    it(`${stage}: one Lena card at her first hold, €20.00 pledged, her parts as the book counts them`, () => {
      const f = get(stage);
      for (const [screen, html] of Object.entries(screens(f))) {
        const lena = cards(html, f.lena);
        expect(lena, screen).toHaveLength(1);
        expect(cards(html, f.renewal), screen).toHaveLength(0);
        expect(html.split('data-flow="hold:').length - 1, screen).toBe(4); // Lena, Mark, Yuki and the match
        const card = lena[0];
        expect(card, screen).toContain(`<b>${eur(2000)}</b>`);
        expect(card, screen).toContain(eur(WANT[stage].charged));
        expect(card, screen).toContain(eur(2000 - WANT[stage].charged));
        expect(card, screen).toContain(stage === "closed" ? "Rest never charged" : "Partly spent");
      }
    });

    it(`${stage}: who paid for water names Lena once, her shares from both holds together`, () => {
      const f = get(stage);
      const water = shareGroups(f.view).find((g) => g.needId === "water")!;
      const lena = water.donors.filter((d) => d.name.startsWith("Lena"));
      expect(lena).toHaveLength(1);
      expect(lena[0]).toMatchObject({ pledgeId: f.lena, amount: WANT[stage].charged, base: lenaShares(f).reduce((a, r) => a + r.base, 0) });
      // the Coordinator's "Who pays for each need" panel, up to the next panel's title
      const panel = screens(f).coordinator.split("Who pays for each need")[1].split("<h3")[0];
      expect(panel.split("Lena ").length - 1).toBe(1);
      expect(panel).toContain(`Lena ¥${lenaShares(f).reduce((a, r) => a + r.base, 0).toLocaleString("en-US")} (${eur(WANT[stage].charged)})`);
    });
  }
});

describe("the statement: one story by either hold's id", () => {
  for (const stage of STAGES) {
    it(`${stage}: the same chain by her first hold and by her renewal; the first hold's page goes to the latest`, () => {
      const f = get(stage);
      const byOld = chainOf(f.statements.lena);
      const byNew = chainOf(f.statements.renewal);
      expect(byOld).not.toBeNull();
      expect(byNew).toEqual(byOld);
      const c = byOld!;
      expect([c.first, c.latest]).toEqual([f.lena, f.renewal]);
      expect(statementTarget(f.statements.lena.statement.balance.pledgeId, c)).toBe(c.latest);
      expect(statementTarget(f.statements.renewal.statement.balance.pledgeId, c)).toBeNull();
    });

    it(`${stage}: one bar over the chain, the same parts as the book's Lena`, () => {
      const f = get(stage);
      const c = chainOf(f.statements.renewal)!;
      const bar = chainMeter(c);
      const book = deriveLedger(f.view).donors.find((d) => d.pledgeId === f.lena)!.meter!;
      expect(bar).toEqual(book);
      expect({ total: bar.total, charged: bar.charged, held: bar.held, never: bar.never }).toEqual({ total: 2000, charged: WANT[stage].charged, held: WANT[stage].held, never: WANT[stage].never });
    });

    it(`${stage}: the story says pledged, renewed with the rest, the first hold ended without a second charge`, () => {
      const f = get(stage);
      const story = chainStory(chainOf(f.statements.renewal)!).map((l) => l.text);
      expect(story[0]).toMatch(/you pledged €20\.00/);
      expect(story[1]).toMatch(/renewed\. .*keeps the €16\.67 not spent yet/);
      expect(story[2]).toMatch(/the first hold ended\. .*Nothing was charged twice/);
      expect(story.slice(3)).toEqual(stage === "closed" ? [expect.stringMatching(/the hold ended\. €13\.34 was never charged\./)] : []);
      expect(story.join(" ")).not.toMatch(/€16\.67 was never charged|€20\.00 was never charged/);
    });

    it(`${stage}: the lines of the whole chain, each with Lena's own share, on the latest hold's page`, () => {
      const f = get(stage);
      const c = chainOf(f.statements.renewal)!;
      const st = chainRows(f.statements.renewal.statement, c);
      expect(st.rows).toHaveLength(WANT[stage].lines);
      for (const r of lenaShares(f)) {
        const [line] = statementLines(f.view, st, r.receiptId, [r.lineNo]);
        expect(line.share).toBe(r.amount);
      }
      // her own first line, paid by the first hold, keeps its €3.33 on the new hold's page
      const first = lenaShares(f).find((r) => r.pledgeId === f.lena)!;
      expect(statementLines(f.view, st, first.receiptId, [first.lineNo])[0].share).toBe(333);
    });
  }
});

describe('the agent ("Ask the book"): Lena once, nothing counted twice', () => {
  for (const stage of STAGES) {
    it(`${stage}: one hit, her figures over the chain, the same as the book`, () => {
      const f = get(stage);
      const hits = findHolds(f.view, "Lena");
      expect(hits).toHaveLength(1);
      expect(hits[0].pledgeId).toBe(f.lena);
      const d = donorFigures(f.view, hits[0]);
      expect(d.pledged).toBe(2000);
      expect(d.spent).toBe(WANT[stage].charged);
      expect(d.spent + d.held + d.back).toBe(2000);
      expect(stage === "closed" ? d.back : d.held).toBe(2000 - WANT[stage].charged);
      expect(d.rows.filter((r) => r.kind === "donor_share")).toHaveLength(WANT[stage].lines);
      const book = deriveLedger(f.view).donors.find((x) => x.pledgeId === f.lena)!;
      expect({ spent: d.spent, held: d.held, back: d.back }).toEqual({ spent: book.spent, held: book.held, back: book.back });
      expect(ledgerFindDonor(f.view, "Lena").data.donors).toHaveLength(1);
    });

    it(`${stage}: the totals tool lists Lena once and adds up the pledges as the book does`, () => {
      const f = get(stage);
      const t = ledgerTotals(f.view).text;
      expect(t.split("\n").filter((l) => l.startsWith("- Lena"))).toHaveLength(1);
      const m = deriveLedger(f.view);
      const pledged = (ledgerTotals(f.view).data.facts as { label: string; value: number }[]).find((x) => x.label === "pledged in total")!;
      expect(pledged.value).toBe(m.promised);
    });

    it(`${stage}: "How much was never charged?" and "my money" answer over the chain, and the guard passes`, () => {
      const f = get(stage);
      const back = answerStarter(f.view, "back", "Lena", "en");
      expect(back.verdict.ok).toBe(true);
      if (stage === "closed") expect(back.text).toBe(`${eur(1334)} of your ${eur(2000)} was never charged: PayPal released the hold when the drive closed. ${eur(666)} was spent on needs.`);
      else expect(back.text).toBe(`So far ${eur(WANT[stage].charged)} went to needs; ${eur(WANT[stage].held)} is still held for the drive and has not been charged.`);
      const money = answerStarter(f.view, "money", "Lena", "en");
      expect(money.verdict.ok).toBe(true);
      expect(money.text).toMatch(new RegExp(`^Your €20\\.00 hold paid ${eur(WANT[stage].charged).replace(".", "\\.")} for .+: ${WANT[stage].lines} lines?,`));
      expect(ledgerDonorMoney(f.view, "Lena").text.split("\n").filter((l) => l.startsWith("- line"))).toHaveLength(WANT[stage].lines);
    });

    it(`${stage}: the PayPal ids name every capture of her chain, each once`, () => {
      const f = get(stage);
      const captures = [...new Set(lenaShares(f).map((r) => r.captureId).filter(Boolean))];
      const text = ledgerPaypalIds(f.view, "Lena").text;
      for (const id of captures) expect(text.split(`capture ${id}`).length - 1).toBe(1);
    });
  }
});

describe("the Telegram bot's report", () => {
  // The bot reports one receipt's lines (approved, refused, why); it reads no hold, so a renewal cannot change it.
  for (const stage of STAGES) {
    it(`${stage}: each receipt's counts are the screens' counts`, () => {
      const f = get(stage);
      for (const r of f.view.receipts) {
        const c = receiptCounts(f.view, r);
        expect(c.approved).toBe(lineViews(f.view, r).filter((l) => l.state === "approved").length);
        expect(c.refused).toBe(refusalSummary(f.view, r).count);
        expect(c.approved).toBe(1);
      }
    });
  }
});
