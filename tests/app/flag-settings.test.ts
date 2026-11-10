import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { PledgeForm } from "../../src/ui/PledgeForm";
import { RenewOffer } from "../../src/ui/RenewOffer";
import { FAKE_EPOCH, fakeSandbox } from "./support/fake-sandbox";
import { harness, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// How the four money features look once they are switched on, as the drive's owner chose them:
// (a) the renewal button is on every live hold with a rest, and the card is louder in its last 3 days;
// (b) on a demo drive the volunteer's first receipt passes at once, with an honest line that a real drive checks it;
// (e) the pledge form starts on "release the rest". (c) is in all-flags.test.ts, (d) in src/core/carry.test.ts.

vi.setConfig({ testTimeout: 60_000 });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function demo(driveId: string) {
  let now: () => string = () => FAKE_EPOCH;
  const pp = fakeSandbox({ now: () => now() });
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  now = () => h.clock.now();
  await h.svc.createDemoDrive({ driveId });
  return { h, pp, rec, driveId, lena: `${driveId}.water` };
}

/** The renewal card as the statement page renders it, at the server's clock (the card counts days from the browser's). */
function card(offer: Parameters<typeof RenewOffer>[0]["offer"], at: string): string {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  return renderToStaticMarkup(createElement(RenewOffer, { pledgeId: "x", offer, needId: "water" }));
}

describe("(a) the renewal button on a live hold with a rest", () => {
  it("is there from the first day; in the last 3 days the card is the louder reminder; never once the hold has ended", async () => {
    vi.stubEnv("RENEW_ENABLED", "1");
    const s = await demo("demo-flags-renew");
    const day0 = (await s.h.svc.getStatement(s.lena)).renewal!;
    const fresh = card(day0, s.h.clock.now());
    expect(fresh).toContain('data-testid="renew-offer"');
    expect(fresh).toContain('data-testid="renew-button"');
    expect(fresh).toContain("Renew €20.00 for 29 more days");
    expect(fresh).not.toContain("box-shadow");

    // a line spends part of it: the button stays, for what is left
    await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 931, [{ needId: "water", qty: 10, amount: 1080 }]).bytes });
    const spent = (await s.h.svc.getStatement(s.lena)).renewal!;
    expect(spent.available.minor).toBeGreaterThan(0);
    expect(spent.available.minor).toBeLessThan(2000);
    expect(card(spent, s.h.clock.now())).toContain(`Renew €${(spent.available.minor / 100).toFixed(2)} for 29 more days`);

    s.h.clock.set(new Date(Date.parse(day0.remindFrom!) + 60_000).toISOString());
    const late = (await s.h.svc.getStatement(s.lena)).renewal!;
    const loud = card(late, s.h.clock.now());
    expect(loud).toContain('data-testid="renew-remind"');
    expect(loud).toContain('data-testid="renew-button"');
    expect(loud).toContain("Your hold ends in 3 days");
    expect(loud).toContain("box-shadow:inset 3px 0 0 var(--btn)");

    s.h.clock.set(new Date(Date.parse(day0.expiresAt!) + 60_000).toISOString());
    const ended = card((await s.h.svc.getStatement(s.lena)).renewal!, s.h.clock.now());
    expect(ended).not.toContain('data-testid="renew-button"');
  });

  it("with renewals off the statement has no renewal and the card shows nothing", async () => {
    vi.stubEnv("RENEW_ENABLED", "");
    const s = await demo("demo-flags-renew-off");
    const st = await s.h.svc.getStatement(s.lena);
    expect("renewal" in st).toBe(false);
    expect(card(undefined, s.h.clock.now())).toBe("");
  });
});

describe("(b) a demo drive's volunteer", () => {
  it("their first receipt passes at once, and the coordinator's card says a real drive has a person check it", async () => {
    vi.stubEnv("VOLUNTEER_INVITES", "1");
    const s = await demo("demo-flags-vol");
    const out = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 932, [{ needId: "water", qty: 4, amount: 432 }]).bytes });
    expect(out.receipt).toMatchObject({ status: "funded", volunteerId: "demo-volunteer" });
    expect(out.receipt.flags.map((f) => f.code)).not.toContain("first_receipt");
    const view = await s.h.svc.getDriveView(s.driveId);
    const html = renderToStaticMarkup(createElement(CoordinatorView, { view, following: false, refresh: async () => undefined, follow: () => undefined }));
    expect(html).toContain('data-testid="volunteers"');
    expect(html).toContain("demo: the first-receipt check is skipped for this volunteer; on a real drive a person checks each new volunteer&#x27;s first receipt");
  });
});

describe("(e) the pledge form", () => {
  it("starts on releasing the rest; keeping it for the drive is the donor's choice", () => {
    const html = renderToStaticMarkup(createElement(PledgeForm, { driveId: "d", needId: "water", needLabel: "Water", restChoice: true }));
    expect(html).toContain('data-testid="rest-choice"');
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.filter((r) => r.includes('checked=""'))).toEqual([expect.stringContaining('value="release"')]);
    // without the feature there is no choice at all, and the rest is released as before
    expect(renderToStaticMarkup(createElement(PledgeForm, { driveId: "d", needId: "water", needLabel: "Water" }))).not.toContain("rest-choice");
  });
});
