import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as demoPOST } from "../../src/app/api/demo/drives/route";
import { POST as receiptsPOST } from "../../src/app/api/drives/[id]/receipts/route";
import { POST as volunteerPOST } from "../../src/app/api/drives/[id]/volunteers/[vid]/route";
import { POST as invitePOST } from "../../src/app/api/drives/[id]/volunteers/route";
import { POST as decisionPOST } from "../../src/app/api/receipts/[id]/decision/route";
import { drives } from "../../src/db/schema";
import { setServiceForTests } from "../../src/server/runtime";
import { CoordinatorView } from "../../src/ui/CoordinatorView";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// Volunteers by invitation switched on (VOLUNTEER_INVITES), through the routes the pages call. The judges' one-click
// path on a demo drive still works; on a real drive the coordinator's actions need COORDINATOR_SECRET, and without it
// they are a clean 403 with a sentence (never a 500), which the coordinator's card says instead of offering buttons.

vi.setConfig({ testTimeout: 60_000 });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }) }));

const DEMO_EMAIL = "sb-pywsi53523660@personal.example.com";
const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.77", ...headers } });
const upload = (path: string, bytes: Uint8Array) => {
  const form = new FormData();
  form.set("image", new File([Buffer.from(bytes)], "receipt.png", { type: "image/png" }));
  return new Request(`http://localhost${path}`, { method: "POST", body: form, headers: { "x-forwarded-for": "192.0.2.77" } });
};
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const screen = async (h: Awaited<ReturnType<typeof harness>>, driveId: string) =>
  renderToStaticMarkup(createElement(CoordinatorView, { view: await h.svc.getDriveView(driveId), following: false, refresh: async () => undefined, follow: () => undefined }));

async function setup() {
  const pp = fakeSandbox();
  const rec = loadRecordings();
  const h = await harness({ fetch: pp.fetch, recordings: rec });
  setServiceForTests(h.svc);
  return { pp, rec, h };
}

beforeEach(() => vi.stubEnv("VOLUNTEER_INVITES", "1"));
afterEach(() => {
  setServiceForTests(undefined);
  vi.unstubAllEnvs();
});

describe("a demo drive with invitations on", () => {
  it("the judge opens a drive and sends the sample receipt: funded at once, paid to the demo's own volunteer", async () => {
    const s = await setup();
    const res = await demoPOST(new Request("http://localhost/api/demo/drives", { method: "POST", headers: { "x-forwarded-for": "192.0.2.77" } }));
    expect(res.status).toBe(201);
    const driveId = (await res.json()).drive.id as string;
    const sent = await receiptsPOST(upload(`/api/drives/${driveId}/receipts`, heroBytes()), ctx({ id: driveId }));
    expect(sent.status).toBe(201);
    const { receipt } = await sent.json();
    expect(receipt).toMatchObject({ status: "funded", volunteerId: "demo-volunteer" });
    expect(s.pp.payouts).toEqual([expect.objectContaining({ receiver: DEMO_EMAIL })]);
  });

  it("the coordinator's card lists who is invited with masked addresses; the demo's own volunteer has no buttons", async () => {
    const s = await setup();
    const driveId = "demo-vol-card";
    await s.h.svc.createDemoDrive({ driveId });
    const inv = await invitePOST(req(`/api/drives/${driveId}/volunteers`, { name: "Maria", payoutEmail: "maria.lopez@example.com", limitMinor: 5000 }), ctx({ id: driveId }));
    expect(inv.status).toBe(201);
    const html = await screen(s.h, driveId);
    const rows = html.split('data-testid="volunteer-row"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Haruto");
    expect(rows[0]).toContain(`PayPal s***@personal.example.com`);
    expect(rows[0]).not.toContain(">Remove<");
    expect(rows[1]).toContain("Maria");
    expect(rows[1]).toContain("PayPal m***@example.com");
    expect(rows[1]).toContain("limit ¥5,000");
    expect(rows[1]).toContain(">Remove<");
    expect(html).not.toContain("maria.lopez@example.com");
    expect(html).not.toContain(DEMO_EMAIL);
    expect(html).toContain('aria-label="Invite a volunteer"');
    expect(html).not.toContain('data-testid="volunteers-coordinator-only"');
  });
});

describe("a real drive with invitations on", () => {
  async function real(driveId: string) {
    // A real drive is opened from the demo one (its holds), made before invitations: it has no demo volunteer.
    const s = await setup();
    vi.stubEnv("VOLUNTEER_INVITES", "");
    await s.h.svc.createDemoDrive({ driveId });
    await s.h.db.db.update(drives).set({ demo: false }).where(eq(drives.id, driveId));
    vi.stubEnv("VOLUNTEER_INVITES", "1");
    return { ...s, driveId };
  }

  it("without COORDINATOR_SECRET every coordinator action is a 403 with a sentence, and nothing moves", async () => {
    vi.stubEnv("COORDINATOR_SECRET", "");
    const s = await real("real-vol-403");
    const inv = await invitePOST(req(`/api/drives/${s.driveId}/volunteers`, { name: "Mallory", payoutEmail: "mallory@example.com" }, { authorization: "Bearer " }), ctx({ id: s.driveId }));
    expect(inv.status).toBe(403);
    expect(await inv.json()).toEqual({ error: "coordinator_only", message: "Only the drive's coordinator invites volunteers and changes them." });

    // a volunteer the coordinator invited (with the key, here through the service) and her first receipt, in review
    const maria = await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, { coordinator: true });
    const { receipt } = await s.h.svc.submitReceipt({ driveId: s.driveId, bytes: syntheticReceipt(s.rec, 951, [{ needId: "water", qty: 4, amount: 432 }]).bytes, volunteerToken: maria.token });
    expect(receipt.status).toBe("review");
    const calls = s.pp.calls.length;
    for (const body of [{ action: "remove" }, { action: "limit", limitMinor: 100 }]) {
      const r = await volunteerPOST(req(`/api/drives/${s.driveId}/volunteers/${maria.volunteerId}`, body), ctx({ id: s.driveId, vid: maria.volunteerId }));
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe("coordinator_only");
    }
    const decided = await decisionPOST(req(`/api/receipts/${receipt.id}/decision`, { decision: "approve", reason: "I approve myself" }), ctx({ id: receipt.id }));
    expect(decided.status).toBe(403);
    expect(await decided.json()).toEqual({ error: "coordinator_only", message: "Only the drive's coordinator decides on a volunteer's receipt." });
    expect(s.pp.calls.length).toBe(calls);
    expect(s.pp.payouts).toEqual([]);
    const view = await s.h.svc.getDriveView(s.driveId);
    expect(view.volunteers!.map((v) => [v.name, v.active])).toEqual([["Maria", true]]);
    expect(view.receipts.find((r) => r.id === receipt.id)!.status).toBe("review");
  });

  it("with COORDINATOR_SECRET a wrong key is a 403, the right one invites", async () => {
    vi.stubEnv("COORDINATOR_SECRET", "coordinator-test-key");
    const s = await real("real-vol-key");
    const wrong = await invitePOST(req(`/api/drives/${s.driveId}/volunteers`, { name: "Maria", payoutEmail: "maria@example.com" }, { authorization: "Bearer not-the-key" }), ctx({ id: s.driveId }));
    expect(wrong.status).toBe(403);
    const right = await invitePOST(req(`/api/drives/${s.driveId}/volunteers`, { name: "Maria", payoutEmail: "maria@example.com" }, { authorization: "Bearer coordinator-test-key" }), ctx({ id: s.driveId }));
    expect(right.status).toBe(201);
    expect(await right.json()).toMatchObject({ volunteerId: expect.stringMatching(/^vol-/), uploadPath: expect.stringContaining("as=volunteer&volunteer=") });
  });

  it("the coordinator's card lists the volunteers read-only and says why, instead of buttons that would be refused", async () => {
    const s = await real("real-vol-card");
    await s.h.svc.inviteVolunteer(s.driveId, { name: "Maria", payoutEmail: "maria@example.com" }, { coordinator: true });
    const html = await screen(s.h, s.driveId);
    expect(html).toContain('data-testid="volunteers-coordinator-only"');
    expect(html).toContain("On a real drive only its coordinator invites, limits and removes volunteers");
    const rows = html.split('data-testid="volunteer-row"').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("PayPal m***@example.com");
    expect(rows[0]).not.toContain(">Remove<");
    expect(rows[0]).not.toContain(">Limit<");
    expect(html).not.toContain('aria-label="Invite a volunteer"');
  });
});
