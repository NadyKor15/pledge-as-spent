import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevSpendLedger, META_AGENT_CAP_MAX_USD } from "./agent";

// The measure's file ledger is shared with the receipt reading (`read-meta:` rows). Its two ceilings: the lane's own
// "agent-dev" entries under the lane's cap, and the whole file under Meta's credits. 10.11 the lane's cap was applied to
// the whole file, and every live measure call was refused before Meta was asked.

const row = (what: string, usd: number) => JSON.stringify({ ts: "2026-11-10T00:00:00.000Z", id: what + usd, kind: "reserve", what, usd });

function ledger(lines: string[]): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "dev-ledger-")), "meta.jsonl");
  writeFileSync(f, lines.length ? `${lines.join("\n")}\n` : "");
  return f;
}

const entry = (usd: number) => ({ ts: "2026-11-10T07:37:37.000Z", id: `t${usd}`, kind: "reserve" as const, what: "agent-dev measure-D-test meta ledger (muse-spark-1.3)", usd });

describe("DevSpendLedger: the lane's ceiling and Meta's credits", () => {
  it("the reading's rows in the same file do not count against the lane's ceiling ($2.70 read + $0.24 agent-dev, cap $0.54)", async () => {
    const f = ledger([row("read-meta:eval holdout", 2.7), row("agent-dev measure-D-old", 0.236)]);
    const l = new DevSpendLedger(f, "agent-dev", 0.536);
    await expect(l.reserve(entry(0.0178), l.capUsd)).resolves.not.toThrow();
  });

  it("the lane's own entries past its cap are refused", async () => {
    const f = ledger([row("read-meta:eval holdout", 2.7), row("agent-dev measure-D-old", 0.53)]);
    const l = new DevSpendLedger(f, "agent-dev", 0.536);
    await expect(l.reserve(entry(0.0178), l.capUsd)).rejects.toThrow(/development ceiling \$0.536 for "agent-dev" reached/);
  });

  it("the whole file past Meta's credits is refused, whatever the lane's cap", async () => {
    const f = ledger([row("read-meta:eval holdout", META_AGENT_CAP_MAX_USD - 0.01), row("agent-dev measure-D-old", 0.1)]);
    const l = new DevSpendLedger(f, "agent-dev", 0.9);
    await expect(l.reserve(entry(0.0178), l.capUsd)).rejects.toThrow(/ceiling \$5\.00/);
  });
});
