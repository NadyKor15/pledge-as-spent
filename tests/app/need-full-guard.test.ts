import { describe, expect, it, vi } from "vitest";
import { answerStarter } from "../../src/agent/starters";
import { ledgerRefusals } from "../../src/agent/tools";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, loadRecordings } from "./support/harness";
import { syntheticReceipt } from "./support/synthetic";

// A line refused because its need was already covered: the book's reason says "<need> is already fully covered".
// The assistant's guard reads "fully" as 100 % of a need, so the need's coverage must be among the figures it
// checks against; otherwise every quick answer about refusals on such a drive is marked unchecked.

vi.setConfig({ testTimeout: 60_000 });

describe("a refusal because the need was already covered", () => {
  it("passes the guard in every language: the need's 100 % is a figure of the book", async () => {
    const rec = loadRecordings();
    const h = await harness({ fetch: fakeSandbox().fetch, recordings: rec });
    const driveId = "demo-need-full";
    await h.svc.createDemoDrive({ driveId });
    await h.svc.submitReceipt({ driveId, bytes: syntheticReceipt(rec, 971, [{ needId: "water", qty: 40, amount: 4320 }]).bytes });
    await h.svc.submitReceipt({ driveId, bytes: heroBytes() }); // its water lines come after water was covered
    const v = await h.svc.getDriveView(driveId);
    const full = v.ledger.filter((r) => r.code === "need_full");
    expect(full.length).toBeGreaterThan(0);
    expect(full.every((r) => r.needId === "water")).toBe(true);
    const tool = ledgerRefusals(v);
    expect(tool.text).toContain("is already fully covered");
    expect(tool.data.facts).toContainEqual(expect.objectContaining({ value: 100, unit: "%", topic: "need" }));
    for (const l of ["en", "de", "ja"] as const) {
      const a = answerStarter(v, "refused", null, l);
      expect(a.verdict, a.text).toMatchObject({ ok: true, unmatched: [] });
    }
  });
});
