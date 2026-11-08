import { describe, expect, it } from "vitest";
import { planLabel } from "../agent/model-plan";
import { agentModelPlan } from "./agent-env";

// The chat's small print before its first answer follows the server's setting. The hosted demo runs Meta Muse
// Spark with Nova Lite as fallback; a server without Meta's key runs Nova Lite alone.

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const KEY = "meta-key-that-must-stay-on-the-server";
const META_ON = env({ LIVE_AGENT: "on", AGENT_META_ALLOWED: "yes", META_AGENT_CAP_USD: "5", META_MODEL_API_KEY: KEY });

describe("the model the chat names before its first answer", () => {
  it("Meta allowed, with a ceiling and a key: Meta Muse Spark, falling back to Amazon Nova Lite", () => {
    expect(agentModelPlan(META_ON)).toBe("meta");
    expect(planLabel(agentModelPlan(META_ON), "en")).toBe("Meta Muse Spark · falls back to Amazon Nova Lite");
    expect(planLabel(agentModelPlan(META_ON), "de")).toBe("Meta Muse Spark · ersatzweise Amazon Nova Lite");
    expect(planLabel(agentModelPlan(META_ON), "ja")).toBe("Meta Muse Spark · 予備は Amazon Nova Lite");
  });

  it("anything less than all three: Amazon Nova Lite", () => {
    const off = [
      env({ LIVE_AGENT: "on" }),
      env({}),
      env({ ...(META_ON as Record<string, string>), META_MODEL_API_KEY: "" }),
      env({ ...(META_ON as Record<string, string>), AGENT_META_ALLOWED: "no" }),
      env({ ...(META_ON as Record<string, string>), META_AGENT_CAP_USD: "0" }),
    ];
    for (const e of off) {
      expect(agentModelPlan(e)).toBe("nova");
      expect(planLabel(agentModelPlan(e), "en")).toBe("Amazon Nova Lite");
    }
  });

  it("hands the page a word, never the key", () => {
    expect(JSON.stringify({ modelPlan: agentModelPlan(META_ON) })).not.toContain(KEY);
  });
});
