import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runScenario, type ScenarioResult } from "../../scripts/lib/e2e-scenario";
import { answerStarter, STARTERS } from "../../src/agent/starters";
import { donorFigures, findHolds, ledgerDonorMoney, ledgerFindDonor, ledgerLine, ledgerPaypalIds, ledgerRefusals, ledgerTotals } from "../../src/agent/tools";
import { DAY_MS } from "../../src/core";
import { receiptCounts } from "../../src/server/telegram";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { DonorView } from "../../src/ui/DonorView";
import { HoldMeter } from "../../src/ui/HoldMeter";
import { meterParts, METER_KEYS } from "../../src/ui/hold-meter";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { journalOf } from "../../src/ui/ledger/journal";
import { needMeter } from "../../src/ui/ledger/need-meter";
import { RebindOffer } from "../../src/ui/RebindOffer";
import { RenewOffer } from "../../src/ui/RenewOffer";
import { RulesNote } from "../../src/ui/RulesNote";
import { chainMeter, chainOf, chainStory } from "../../src/ui/statement/chain";
import { ChainStory } from "../../src/ui/statement/ChainStory";
import { VolunteerView } from "../../src/ui/VolunteerView";
import { FAKE_EPOCH, fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings, ROOT, type Harness } from "./support/harness";
import { appE2eMeta, sandboxReplay } from "./support/sandbox-replay";
import { syntheticReceipt } from "./support/synthetic";

// All four money features switched on together (REBIND_ENABLED, RENEW_ENABLED, VOLUNTEER_INVITES, DONOR_RULES), as
// deploy 7 runs them. (1) The judges' demo drive, replayed strictly from the live sandbox run: the same PayPal requests
// and the same numbers as the README, the gallery and the video. (2) A demo drive that uses every feature at once: a
// renewal, a carried rest, a donor's rule, an invited volunteer whose first receipt a person approves, the sample
// receipt, a capture and the close. The book adds up and every screen renders.

vi.setConfig({ testTimeout: 120_000 });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

const FLAGS = ["REBIND_ENABLED", "RENEW_ENABLED", "VOLUNTEER_INVITES", "DONOR_RULES"] as const;
beforeAll(() => {
  for (const f of FLAGS) vi.stubEnv(f, "1");
});
afterAll(() => vi.unstubAllEnvs());

describe("all four on: the judges' demo drive, replayed from the live sandbox run", () => {
  const meta = appE2eMeta();
  let pp: ReturnType<typeof sandboxReplay>;
  let r: ScenarioResult;
  let h: Harness;
  beforeAll(async () => {
    pp = sandboxReplay();
    h = await harness({ fetch: pp.fetch, start: meta.startedAt, demoPayoutEmail: meta.volunteer, webhookId: null });
    r = await runScenario({ driveId: meta.driveId, fetch: pp.fetch, make: (f) => h.restart(f), read: (rel) => new Uint8Array(readFileSync(path.join(ROOT, rel))), wait: async (ms) => h.clock.advance(ms) });
  });

  it("the features are on, and PayPal gets exactly the recorded requests: each used once, nothing extra", () => {
    expect(r.final.features).toEqual({ carry: true, renew: true, invites: true, rules: true });
    expect(pp.log.filter((l) => !l.repeat)).toHaveLength(pp.exchanges.length);
    expect(pp.log.filter((l) => l.repeat)).toEqual([]);
  });

  it("the showcase numbers are unchanged: funded ¥10,448, payout ¥10,448, match ¥5,224; Lena €4.58, Mark $21.45, Yuki ¥1,237", () => {
    const need = Object.fromEntries(r.final.needs.map((n) => [n.needId, n]));
    expect(need.water).toMatchObject({ qtyCovered: 12, fundedBase: 1486, donorBase: 743, matchBase: 743 });
    expect(need.diapers).toMatchObject({ qtyCovered: 6, fundedBase: 6488, donorBase: 3244, matchBase: 3244 });
    expect(need.batteries).toMatchObject({ qtyCovered: 50, fundedBase: 2474, donorBase: 1237, matchBase: 1237 });
    expect(r.final.match.usedBase).toBe(5224);
    expect(r.final.payouts[0].attempts[0]).toMatchObject({ amount: 10448, status: "confirmed" });
    const close = Object.fromEntries(r.final.closeReport.map((c) => [c.pledgeId.split(".").pop(), c]));
    expect(close.water).toMatchObject({ pledged: 2000, spent: 458, released: 1542 });
    expect(close.diapers).toMatchObject({ pledged: 3000, spent: 2145, released: 855 });
    expect(close.batteries).toMatchObject({ pledged: 3000, spent: 1237, released: 1763 });
    expect(close.match).toMatchObject({ pledged: 500_000, spent: 5224, released: 494_776 });
    for (const c of r.final.closeReport) expect(c.pledged).toBe(c.spent + c.released);
    // the Ledger's figures of the gallery and the README
    const m = deriveLedger(r.final);
    expect([m.spent, m.match, m.held]).toEqual([5224, 5224, 0]);
  });
});

/** A demo drive that uses all four features at once, made by the service (fake sandbox, PGlite). */
async function everything() {
  const driveId = "demo-all-flags";
  let now: () => string = () => FAKE_EPOCH;
  const pp = fakeSandbox({ now: () => now() });
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  now = () => h.clock.now();
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000);
      await h.svc.reconcile(driveId, { graceMinutes: 0 });
    }
  };
  const pledge = async (input: Omit<Parameters<typeof h.svc.createPledge>[0], "driveId">) => {
    const p = await h.svc.createPledge({ driveId, ...input });
    pp.approve(p.orderId);
    await h.svc.approvePledge(p.pledgeId, p.orderId);
    return p.pledgeId;
  };
  await h.svc.createDemoDrive({ driveId });
  const lena = `${driveId}.water`;
  // Claire keeps her rest for the drive; Dan pays diapers at most $1.00 a pack (every pack here is dearer)
  const claire = await pledge({ needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR", minor: 1000 }, rest: "carry" });
  const dan = await pledge({ needId: "diapers", donorName: "Dan (Austin)", amount: { currency: "USD", minor: 1000 }, rules: { maxUnitMinor: 100 } });
  const maria = await h.svc.inviteVolunteer(driveId, { name: "Maria", payoutEmail: "maria@example.com" });
  // day 0: a receipt from the demo's own volunteer, funded at once
  const first = await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 961, [{ needId: "water", qty: 10, amount: 1080 }]).bytes });
  // day 27: Lena renews with the sandbox test card; Claire renews in the PayPal window
  h.clock.advance(27 * DAY_MS);
  const lenaNew = (await h.svc.renewPledge(lena)).pledgeId;
  const c = await h.svc.renewPledge(claire);
  pp.approve(c.orderId);
  await h.svc.approvePledge(c.pledgeId, c.orderId);
  await settle();
  // Maria's first receipt waits for a person; approved, it covers water (Claire's renewal carries on to diapers) and buys diapers
  const second = await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 962, [{ needId: "water", qty: 30, amount: 3240 }, { needId: "diapers", qty: 2, amount: 2596 }]).bytes, volunteerToken: maria.token });
  const review = second.receipt.status;
  await h.svc.coordinatorDecision(second.receipt.id, "approve", "Checked with Maria");
  const open = { view: await h.svc.getDriveView(driveId), claireStatement: await h.svc.getStatement(c.pledgeId) };
  // the judges' sample receipt, the capture, the close
  const sample = await h.svc.submitReceipt({ driveId, bytes: heroBytes() });
  await h.svc.captureNow(driveId);
  await settle();
  await h.svc.closeDrive(driveId);
  await settle();
  const view = await h.svc.getDriveView(driveId);
  const statements = Object.fromEntries(await Promise.all(view.holds.map(async (x) => [x.pledgeId, await h.svc.getStatement(x.pledgeId)] as const)));
  return { h, pp, driveId, lena, lenaNew, claire, claireNew: c.pledgeId, dan, maria, first, second, review, sample, open, view, statements };
}

describe("all four on: one demo drive uses every feature, then closes", () => {
  let f: Awaited<ReturnType<typeof everything>>;
  beforeAll(async () => {
    f = await everything();
  });

  it("each feature did what it says: renewals linked, a rest carried, a rule kept a hold out, a first receipt checked by a person", () => {
    const hold = (id: string) => f.view.holds.find((x) => x.pledgeId === id)!;
    expect(hold(f.lena)).toMatchObject({ renewedTo: f.lenaNew, status: "voided" });
    expect(hold(f.claire)).toMatchObject({ renewedTo: f.claireNew, status: "voided" });
    // Claire's renewal carried her rest on: to diapers once water was covered, to batteries once the sample covered diapers
    expect(f.open.view.holds.find((x) => x.pledgeId === f.claireNew)).toMatchObject({ renews: f.claire, rest: "carry", needId: "diapers" });
    expect(hold(f.claireNew)).toMatchObject({ renews: f.claire, rest: "carry", needId: "batteries" });
    expect(hold(f.claireNew).carried!.map((x) => [x.fromNeedId, x.toNeedId])).toEqual([
      ["water", "diapers"],
      ["diapers", "batteries"],
    ]);
    expect(hold(f.dan)).toMatchObject({ rules: { maxUnitMinor: 100 }, captured: 0, accrued: 0 });
    expect(f.statements[f.dan].statement.ruledOut?.length).toBeGreaterThan(0);
    expect(f.first.receipt).toMatchObject({ status: "funded", volunteerId: "demo-volunteer" });
    expect(f.review).toBe("review");
    expect(f.view.receipts.find((r) => r.id === f.second.receipt.id)).toMatchObject({ status: "funded", volunteerId: f.maria.volunteerId });
    expect(f.pp.payouts.map((p) => p.receiver)).toContain("maria@example.com");
    expect(f.view.drive.status).toBe("closed");
  });

  it("the book adds up: every hold pledged = spent + released; the Ledger's pledged = spent + returned; each donor once", () => {
    for (const c of f.view.closeReport) expect(c.pledged).toBe(c.spent + c.released);
    expect(f.view.closeReport.every((c) => c.settled)).toBe(true);
    for (const h of f.view.holds) expect(h.captured + h.capturePending + h.accrued + h.uncollected).toBeLessThanOrEqual(h.authorized);
    const m = deriveLedger(f.view);
    expect(m.held).toBe(0);
    expect(m.promised).toBe(m.spent + m.returned);
    expect(m.donors.map((d) => d.name).sort()).toEqual(["Claire", "Dan", "Lena", "Mark", "Yuki"]);
    for (const d of m.donors) {
      expect(METER_KEYS.reduce((a, k) => a + d.meter![k], 0)).toBe(d.meter!.total);
      expect(d.spent + d.back).toBe(d.meter!.total);
    }
    // a renewed pledge counts its first hold's amount once, and what its holds were charged
    for (const [root, next] of [
      [f.lena, f.lenaNew],
      [f.claire, f.claireNew],
    ]) {
      const d = m.donors.find((x) => x.pledgeId === root)!;
      const first = f.view.holds.find((x) => x.pledgeId === root)!;
      expect(d.meter!.total).toBe(first.authorized);
      const charged = f.view.ledger.filter((r) => r.kind === "donor_share" && (r.pledgeId === root || r.pledgeId === next)).reduce((a, r) => a + (r.amount ?? 0), 0);
      expect(d.spent).toBe(charged);
      expect(d.meter!.never).toBe(first.authorized - charged);
    }
    // the shelter's money: what the lines were funded with is what donors and the match paid
    const funded = f.view.needs.reduce((a, n) => a + n.fundedBase, 0);
    expect(funded).toBe(m.spent + m.match);
  });

  for (const stage of ["open", "closed"] as const) {
    it(`${stage}: each donor's rest is on one need bar, the need their latest hold backs (Claire's renewal: where it was carried)`, () => {
      const view = stage === "open" ? f.open.view : f.view;
      const m = deriveLedger(view);
      const bars = view.needs.map((n) => needMeter(view, n.needId, m));
      const on = (needId: string) => {
        const b = bars.find((x) => x.needId === needId)!;
        return b.promised + b.returning + b.never + b.back;
      };
      // the latest hold of a donor's chain, by the book's links
      const latest = (id: string) => {
        let h = view.holds.find((x) => x.pledgeId === id)!;
        while (h.renewedTo) h = view.holds.find((x) => x.pledgeId === h.renewedTo)!;
        return h;
      };
      for (const n of view.needs) {
        expect(on(n.needId), n.needId).toBe(m.donors.filter((d) => latest(d.pledgeId).needId === n.needId).reduce((a, d) => a + d.heldBase + d.backBase, 0));
      }
      const claire = m.donors.find((d) => d.pledgeId === f.claire)!;
      const where = stage === "open" ? "diapers" : "batteries";
      expect(latest(f.claire).needId).toBe(where);
      expect(claire.heldBase + claire.backBase).toBeGreaterThan(0);
      if (stage === "open") expect(bars.find((b) => b.needId === "diapers")!.promisedBy).toContain("Claire");
      expect(bars.find((b) => b.needId === "water")!.promisedBy).not.toContain("Claire");
    });
  }

  it("the statements: a renewed pledge is one story by either hold's id; the carried rest and the rule are said", () => {
    for (const [root, next] of [
      [f.lena, f.lenaNew],
      [f.claire, f.claireNew],
    ]) {
      const a = chainOf(f.statements[root]);
      expect(a).not.toBeNull();
      expect(chainOf(f.statements[next])).toEqual(a);
      expect(chainMeter(a!).total).toBe(f.view.holds.find((x) => x.pledgeId === root)!.authorized);
      expect(chainMeter(a!)).toEqual(deriveLedger(f.view).donors.find((d) => d.pledgeId === root)!.meter);
      expect(chainStory(a!).at(-1)!.text).toMatch(/the hold ended\./);
    }
    const labelOf = (id: string) => f.view.needs.find((n) => n.needId === id)?.displayLabel;
    const kept = renderToStaticMarkup(createElement(RebindOffer, { pledgeId: f.claireNew, offer: f.statements[f.claireNew].rebind, labelOf }));
    expect(kept).toContain(`${labelOf("water")} was covered, the rest moved to ${labelOf("diapers")}.`);
    const rules = renderToStaticMarkup(createElement(RulesNote, { statement: f.statements[f.dan].statement, labelOf }));
    expect(rules).toContain("at most $1.00 per unit");
    expect(rules).toContain('data-testid="rules-out"');
  });

  it("every screen and every statement part renders, open and closed", () => {
    const live = { following: false, refresh: async () => undefined, follow: () => undefined };
    for (const view of [f.open.view, f.view]) {
      for (const html of [
        renderToStaticMarkup(createElement(CoordinatorView, { view, ...live })),
        renderToStaticMarkup(createElement(DonorView, { view, role: "donor" })),
        renderToStaticMarkup(createElement(DonorView, { view, role: "shelter" })),
        renderToStaticMarkup(createElement(VolunteerView, { view, ...live })),
      ]) {
        expect(html.length).toBeGreaterThan(1000);
        expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
      }
    }
    for (const st of [f.open.claireStatement, ...Object.values(f.statements)]) {
      const labelOf = (id: string) => f.view.needs.find((n) => n.needId === id)?.displayLabel;
      const chain = chainOf(st);
      const parts = [
        renderToStaticMarkup(createElement(HoldMeter, { parts: chain ? chainMeter(chain) : meterParts(st.statement.balance), size: "card", lang: "en" })),
        chain ? renderToStaticMarkup(createElement(ChainStory, { chain })) : "",
        renderToStaticMarkup(createElement(RebindOffer, { pledgeId: st.statement.balance.pledgeId, offer: st.rebind, labelOf })),
        renderToStaticMarkup(createElement(RenewOffer, { pledgeId: st.statement.balance.pledgeId, offer: st.renewal ?? null, needId: st.statement.balance.needId })),
        renderToStaticMarkup(createElement(RulesNote, { statement: st.statement, labelOf })),
      ];
      for (const html of parts) expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
    }
  });

  it("the Ledger, its journal and the assistant read the same book: each donor once, every quick answer passes the guard", () => {
    for (const view of [f.open.view, f.view]) {
      const m = deriveLedger(view);
      for (const lang of ["en", "de", "ja"] as const) expect(deriveLedger(view, lang).donors).toHaveLength(m.donors.length);
      const j = journalOf(view, m);
      expect(j.events.filter((e) => e.never && (e.pledgeId === f.lena || e.pledgeId === f.claire) && view.drive.status === "open")).toEqual([]);
      expect(ledgerTotals(view).text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(m.donors.length + m.needs.length);
      for (const d of m.donors) {
        const hits = findHolds(view, d.name);
        expect(hits.map((x) => x.pledgeId)).toEqual([d.pledgeId]);
        const fig = donorFigures(view, hits[0]);
        expect({ spent: fig.spent, held: fig.held, back: fig.back }).toEqual({ spent: d.spent, held: d.held, back: d.back });
        expect(ledgerFindDonor(view, d.name).data.donors).toHaveLength(1);
        expect(ledgerDonorMoney(view, d.name).data.error).toBeUndefined();
        expect(ledgerPaypalIds(view, d.name).data.error).toBeUndefined();
        for (const s of STARTERS) {
          const a = answerStarter(view, s.id, s.needsDonor ? d.name : null, "en");
          expect(a.verdict.ok, `${s.id} for ${d.name}: ${a.text} UNMATCHED ${JSON.stringify(a.verdict.unmatched)}`).toBe(true);
        }
      }
      expect(ledgerRefusals(view).data.error).toBeUndefined();
      for (const r of view.receipts) {
        for (const l of r.lines) expect(ledgerLine(view, `${r.id}:${l.lineNo}`).data.error).toBeUndefined();
        const c = receiptCounts(view, r);
        expect(c.approved + c.refused).toBeLessThanOrEqual(r.lines.length);
      }
    }
  });
});
