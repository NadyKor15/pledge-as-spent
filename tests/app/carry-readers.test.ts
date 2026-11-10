import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answerStarter } from "../../src/agent/starters";
import { donorFigures, findHolds, ledgerDonorMoney } from "../../src/agent/tools";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { DonorView } from "../../src/ui/DonorView";
import { meterParts } from "../../src/ui/hold-meter";
import { deriveLedger } from "../../src/ui/ledger/derive";
import { journalOf } from "../../src/ui/ledger/journal";
import { needMeter } from "../../src/ui/ledger/need-meter";
import { RebindOffer } from "../../src/ui/RebindOffer";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// A carried rest (REBIND_ENABLED) on every reader, on views the real service makes (fake sandbox, PGlite). Claire
// pledges €10.00 for water and keeps the rest for the drive; one receipt covers water and buys diapers, so her rest
// moves to diapers and pays there too. It is ONE hold that backs a new need: no reader may count her twice, show her
// rest on water, or call the carried money "never charged".

vi.setConfig({ testTimeout: 60_000 });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

type Stage = "open" | "closed";
const STAGES: Stage[] = ["open", "closed"];

async function carriedDrive(stage: Stage) {
  const driveId = `demo-carry-readers-${stage}`;
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  const p = await h.svc.createPledge({ driveId, needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR", minor: 1000 }, rest: "carry" });
  pp.approve(p.orderId);
  await h.svc.approvePledge(p.pledgeId, p.orderId);
  await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 941, [{ needId: "water", qty: 40, amount: 4320 }, { needId: "diapers", qty: 1, amount: 1298 }]).bytes });
  if (stage === "closed") {
    await h.svc.captureNow(driveId);
    await h.svc.closeDrive(driveId);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000);
      await h.svc.reconcile(driveId, { graceMinutes: 0 });
    }
  }
  return { view: await h.svc.getDriveView(driveId), statement: await h.svc.getStatement(p.pledgeId), claire: p.pledgeId };
}

const drives = new Map<Stage, Awaited<ReturnType<typeof carriedDrive>>>();
beforeAll(async () => {
  vi.stubEnv("REBIND_ENABLED", "1");
  for (const s of STAGES) drives.set(s, await carriedDrive(s));
});
afterAll(() => vi.unstubAllEnvs());
const get = (s: Stage) => drives.get(s)!;
const shares = (f: ReturnType<typeof get>) => f.view.ledger.filter((r) => r.kind === "donor_share" && r.pledgeId === f.claire);

describe("the drive: Claire's rest carried from water to diapers, and paying there", () => {
  for (const stage of STAGES) {
    it(`${stage}: one hold, now backing diapers, with shares on both needs`, () => {
      const f = get(stage);
      const hold = f.view.holds.find((h) => h.pledgeId === f.claire)!;
      expect(f.view.features.carry).toBe(true);
      expect(hold).toMatchObject({ needId: "diapers", rest: "carry", authorized: 1000, carried: [expect.objectContaining({ fromNeedId: "water", toNeedId: "diapers" })] });
      expect(shares(f).map((r) => r.needId)).toEqual(["water", "diapers"]);
      expect(hold.status).toBe(stage === "closed" ? "voided" : "authorized");
    });
  }
});

describe("the book and the need bars", () => {
  for (const stage of STAGES) {
    it(`${stage}: Claire is one donor; what she spent is her shares on both needs; her rest is counted once`, () => {
      const f = get(stage);
      const m = deriveLedger(f.view);
      const d = m.donors.filter((x) => x.name === "Claire");
      expect(d).toHaveLength(1);
      const c = d[0];
      const spent = shares(f).reduce((a, r) => a + (r.amount ?? 0), 0);
      expect(c.spent).toBe(spent);
      expect(c.needIds).toEqual(["water", "diapers"]);
      expect(c.meter!.total).toBe(1000);
      expect(c.spent + c.held + c.back).toBe(1000);
      expect(stage === "closed" ? c.back : c.held).toBe(1000 - spent);
      // while the drive is open, nothing of hers is "never charged": the rest is held for diapers
      expect(c.meter!.never).toBe(stage === "closed" ? 1000 - spent : 0);
      expect(c.neverCharged).toBe(stage === "closed");
      expect(m.promised).toBe(m.spent + m.held + m.returned);
    });

    it(`${stage}: her rest stands on the diapers bar, not on water; every donor's rest is on exactly one bar`, () => {
      const f = get(stage);
      const m = deriveLedger(f.view);
      const bars = f.view.needs.map((n) => needMeter(f.view, n.needId, m));
      const water = bars.find((b) => b.needId === "water")!;
      const diapers = bars.find((b) => b.needId === "diapers")!;
      expect(water.promisedBy).not.toContain("Claire");
      expect(diapers.promisedBy.includes("Claire")).toBe(stage === "open");
      const rests = bars.reduce((a, b) => a + b.promised + b.returning + b.never + b.back, 0);
      expect(rests).toBe(m.donors.reduce((a, d) => a + d.heldBase + d.backBase, 0));
      // the bars' bought + waiting are the lines' shares: Claire's diapers share is on diapers
      const diaperShares = f.view.ledger.filter((r) => (r.kind === "donor_share" || r.kind === "match_share") && r.needId === "diapers").reduce((a, r) => a + r.base, 0);
      expect(diapers.bought + diapers.waiting).toBe(diaperShares);
    });

    it(`${stage}: the PayPal journal has no move of its own (a carry calls nobody); never charged only at the end`, () => {
      const f = get(stage);
      const j = journalOf(f.view, deriveLedger(f.view));
      const hers = j.events.filter((e) => e.pledgeId === f.claire);
      expect(hers.every((e) => e.kind !== "void" || stage === "closed")).toBe(true);
      expect(hers.filter((e) => e.never).map((e) => e.text)).toEqual(stage === "closed" ? ["Claire · rest never charged"] : []);
    });
  }
});

describe("the statement", () => {
  for (const stage of STAGES) {
    it(`${stage}: her lines on both needs, the move said in plain words, held (not never charged) while open`, () => {
      const f = get(stage);
      const st = f.statement.statement;
      expect(st.rows.map((r) => r.needId)).toEqual(["water", "diapers"]);
      expect(st.rows.reduce((a, r) => a + r.share.minor, 0)).toBe(shares(f).reduce((a, r) => a + (r.amount ?? 0), 0));
      const bar = meterParts(st.balance);
      expect(bar.total).toBe(1000);
      expect(bar.never).toBe(stage === "closed" ? 1000 - bar.charged - bar.waiting : 0);
      expect(bar.held).toBe(stage === "closed" ? 0 : 1000 - bar.charged - bar.waiting);
      const labelOf = (id: string) => f.view.needs.find((n) => n.needId === id)?.displayLabel;
      const html = renderToStaticMarkup(createElement(RebindOffer, { pledgeId: f.claire, offer: f.statement.rebind, labelOf }));
      expect(html).toContain('data-testid="rest-kept"');
      expect(html).toContain(`${labelOf("water")} was covered, the rest moved to ${labelOf("diapers")}.`);
      // the rule is a promise while the drive is open; once it closed, only history and what was never charged
      expect(html.includes("moves by itself to the open need")).toBe(stage === "open");
      expect(html.includes("Nothing moves any more. What your hold did not pay for is never charged")).toBe(stage === "closed");
      if (stage === "closed") expect(html).not.toContain('data-testid="rebind-offer"');
    });
  }
});

describe("the screens and the agent", () => {
  for (const stage of STAGES) {
    it(`${stage}: one Claire card on the Coordinator and Donor screens, on diapers`, () => {
      const f = get(stage);
      const live = { following: false, refresh: async () => undefined, follow: () => undefined };
      for (const html of [renderToStaticMarkup(createElement(CoordinatorView, { view: f.view, ...live })), renderToStaticMarkup(createElement(DonorView, { view: f.view, role: "donor" }))]) {
        const cards = html.split('data-flow="hold:').filter((c) => c.startsWith(`${f.claire}"`));
        expect(cards).toHaveLength(1);
        expect(cards[0]).toContain(f.view.needs.find((n) => n.needId === "diapers")!.displayLabel);
        expect(cards[0]).toContain("<b>€10.00</b>");
      }
    });

    it(`${stage}: the agent finds her once, her money by need adds up, and "never charged" only once the drive closed`, () => {
      const f = get(stage);
      const hits = findHolds(f.view, "Claire");
      expect(hits).toHaveLength(1);
      const d = donorFigures(f.view, hits[0]);
      expect(d.needs.map((n) => n.needId)).toEqual(["water", "diapers"]);
      expect(d.needs.reduce((a, n) => a + n.own, 0)).toBe(d.spent);
      expect(d.spent + d.held + d.back).toBe(1000);
      const back = answerStarter(f.view, "back", "Claire", "en");
      expect(back.verdict.ok).toBe(true);
      expect(back.text.includes("never charged")).toBe(stage === "closed");
      expect(ledgerDonorMoney(f.view, "Claire").text).toMatch(/For .+: €.+ over 1 line[\s\S]*For .+: €.+ over 1 line/);
    });
  }
});
