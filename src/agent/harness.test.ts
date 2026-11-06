import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DriveView } from "@/ui/types";
import { LedgerAgent } from "./harness";

// The chat's input is cleared only when the agent took the question: before Studio is attached (or while it is
// built again) a question is refused at once and nothing changes, so the reader's words stay in the box.

const view = JSON.parse(readFileSync(path.resolve(__dirname, "../../tests/fixtures/drives/closed.json"), "utf8")) as DriveView;

describe("LedgerAgent.ask before Studio is ready", () => {
  it("refuses at once (false), asks nothing and changes nothing", () => {
    let opened = 0;
    const agent = new LedgerAgent({
      getView: () => view,
      newQuestion: async () => {
        opened++;
        return { questionId: "q" };
      },
    });
    const before = agent.get();
    expect(agent.ask("What did my money buy?")).toBe(false);
    expect(agent.ask("   ")).toBe(false);
    expect(agent.retry()).toBe(false);
    expect(agent.get()).toBe(before);
    expect(opened).toBe(0);
  });
});
