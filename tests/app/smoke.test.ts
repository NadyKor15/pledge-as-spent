import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../scripts/lib/e2e-scenario";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, ROOT } from "./support/harness";

describe("e2e scenario on the fake sandbox", () => {
  it("runs to a closed drive", async () => {
    const pp = fakeSandbox();
    pp.payoutGetsUntilSuccess = 2;
    const h = await harness({ fetch: pp.fetch });
    const r = await runScenario({
      driveId: "demo-fake000001",
      fetch: pp.fetch,
      make: (f) => h.restart(f),
      read: (rel) => new Uint8Array(readFileSync(path.join(ROOT, rel))),
      wait: async (ms) => h.clock.advance(ms),
    });
    console.log(JSON.stringify({ crash: r.crash, before: r.capturesBeforeCrash, auth: r.authorizeBeforeApproval, dup: r.duplicate.flags, pre: r.preDisaster.flags, lookups: r.lookups, close: r.close, captures: pp.captures, calls: pp.calls.length }, null, 1));
    expect(r.final.drive.status).toBe("closed");
  });
});
