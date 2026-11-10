import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DonorView } from "../../src/ui/DonorView";
import { RulesNote } from "../../src/ui/RulesNote";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// Donor rules on the screens (DONOR_RULES): the pledge form offers them only when the server has them on, and the
// statement says what the donor set and each line the rules kept the hold out of. A line no hold of its need may pay
// is refused and does not count toward the need (the drive's owner chose this: the need stays open for a cheaper buy).
// That the demo's showcase numbers do not move with rules on is in all-flags.test.ts (the live sandbox replay).

vi.setConfig({ testTimeout: 60_000 });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

afterEach(() => vi.unstubAllEnvs());

async function demo(driveId: string) {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  await h.svc.createDemoDrive({ driveId });
  return { pp, rec, h, driveId };
}

describe("the pledge form", () => {
  for (const on of [true, false]) {
    it(`rules ${on ? "on" : "off"}: every open need's form ${on ? "offers" : "has no"} rules; the rest choice follows its own feature`, async () => {
      vi.stubEnv("DONOR_RULES", on ? "1" : "");
      vi.stubEnv("REBIND_ENABLED", on ? "" : "1");
      const s = await demo(`demo-rules-form-${on}`);
      const view = await s.h.svc.getDriveView(s.driveId);
      expect(view.features).toMatchObject({ rules: on, carry: !on });
      const html = renderToStaticMarkup(createElement(DonorView, { view, role: "donor" }));
      const forms = html.split('class="dn-pledgeForm"').length - 1;
      expect(forms).toBe(view.needs.filter((n) => !n.covered).length);
      expect(forms).toBeGreaterThan(0);
      expect(html.split('data-testid="donor-rules"').length - 1).toBe(on ? forms : 0);
      expect(html.split('data-testid="rest-choice"').length - 1).toBe(on ? 0 : forms);
    });
  }
});

describe("the statement's note on the donor's rules", () => {
  it("says the rule, the line it kept the hold out of, and that the refused line did not count toward the need", async () => {
    vi.stubEnv("DONOR_RULES", "1");
    const s = await demo("demo-rules-note");
    const p = await s.h.svc.createPledge({ driveId: s.driveId, needId: "water", donorName: "Claire (Lyon)", amount: { currency: "EUR", minor: 1000 }, rules: { maxUnitMinor: 60 } });
    s.pp.approve(p.orderId);
    await s.h.svc.approvePledge(p.pledgeId, p.orderId);
    await s.h.svc.revokePledge(`${s.driveId}.water`); // Lena withdraws: Claire is the only hold of water
    const before = (await s.h.svc.getDriveView(s.driveId)).needs.find((n) => n.needId === "water")!.qtyCovered;
    const dear = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 981, [{ needId: "water", qty: 4, amount: 432 }]).bytes }); // ¥108 a bottle, above €0.60
    expect(dear.receipt.status).toBe("rejected");
    const view = await s.h.svc.getDriveView(s.driveId);
    expect(view.needs.find((n) => n.needId === "water")!.qtyCovered).toBe(before);
    const st = (await s.h.svc.getStatement(p.pledgeId)).statement;
    const label = view.needs.find((n) => n.needId === "water")!.displayLabel;
    const html = renderToStaticMarkup(createElement(RulesNote, { statement: st, labelOf: (id) => view.needs.find((n) => n.needId === id)?.displayLabel }));
    expect(html).toContain("Your hold pays at most €0.60 per unit, its share of tax included.");
    const out = html.split('data-testid="rules-out"').slice(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`${label}, 4 at €0.67 each: above your €0.60, so your hold did not pay it.`);
    expect(out[0]).toContain(`so the line was refused and did not count toward ${label}.`);
  });

  it("without rules the statement has no note", async () => {
    vi.stubEnv("DONOR_RULES", "1");
    const s = await demo("demo-rules-none");
    const st = (await s.h.svc.getStatement(`${s.driveId}.water`)).statement;
    expect(renderToStaticMarkup(createElement(RulesNote, { statement: st }))).toBe("");
  });
});
