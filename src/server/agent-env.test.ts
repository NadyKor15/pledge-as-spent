import { describe, expect, it } from "vitest";
import { planLabel } from "../agent/model-plan";
import { agentModelPlan } from "./agent-env";

// The chat's small print before its first answer follows the server's setting. The agent runs on Meta Muse Spark
// only; a server without Meta's key has no live agent.

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const KEY = "meta-key-that-must-stay-on-the-server";
const META_ON = env({ LIVE_AGENT: "on", AGENT_META_ALLOWED: "yes", META_AGENT_CAP_USD: "5", META_MODEL_API_KEY: KEY });

describe("the model the chat names before its first answer", () => {
  it("Meta allowed, with a ceiling and a key: Meta Muse Spark, and no other model named", () => {
    expect(agentModelPlan(META_ON)).toBe("meta");
    for (const locale of ["en", "de", "ja"] as const) {
      expect(planLabel(agentModelPlan(META_ON), locale)).toBe("Meta Muse Spark");
      expect(planLabel(agentModelPlan(META_ON), locale)).not.toMatch(/Nova|Amazon|falls back|ersatzweise|予備/);
    }
  });

  it("anything less than all three: the live AI is off, and no other model is named", () => {
    const off = [
      env({ LIVE_AGENT: "on" }),
      env({}),
      env({ ...(META_ON as Record<string, string>), META_MODEL_API_KEY: "" }),
      env({ ...(META_ON as Record<string, string>), AGENT_META_ALLOWED: "no" }),
      env({ ...(META_ON as Record<string, string>), META_AGENT_CAP_USD: "0" }),
    ];
    for (const e of off) {
      expect(agentModelPlan(e)).toBe("off");
      expect(planLabel(agentModelPlan(e), "en")).toBe("Live AI off");
      expect(planLabel(agentModelPlan(e), "de")).toBe("Live-KI aus");
    }
  });

  it("hands the page a word, never the key", () => {
    expect(JSON.stringify({ modelPlan: agentModelPlan(META_ON) })).not.toContain(KEY);
  });
});
