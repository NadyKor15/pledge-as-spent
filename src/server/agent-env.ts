import { META_MODEL } from "../agent/meta-wire";
import type { ModelPlan } from "../agent/model-plan";

// The live agent's Meta settings, read from the environment. Kept apart from src/server/agent.ts so that a page
// can ask which model the chat runs on without loading the agent's server half.

/**
 * Variant D: Meta's Muse Spark on the Responses API, tried first for every turn; Amazon Nova (Bedrock Lite)
 * takes over a question as soon as Meta cannot answer (no key, its ceiling, an HTTP error, a timeout).
 */
export interface MetaProvider {
  baseUrl: string;
  /** Null: allowed but no key on this server, so every turn falls back to Bedrock. */
  apiKey: string | null;
  model: string;
  /** META_AGENT_CAP_USD: the most Meta may cost, over all `agent-meta:` rows; never above META_AGENT_CAP_MAX_USD. */
  capUsd: number;
  /** META_AGENT_DAILY_CAP_USD: the most Meta may cost over any 24 hours (default META_AGENT_DAILY_CAP_DEFAULT_USD). */
  dailyCapUsd?: number;
  fetch?: typeof fetch;
}

/** Meta's ceiling in code (Nadya, 06.11): the environment can lower it, never raise it. */
export const META_AGENT_CAP_MAX_USD = 5;
/** Meta's spend over any 24 hours unless META_AGENT_DAILY_CAP_USD says less. */
export const META_AGENT_DAILY_CAP_DEFAULT_USD = 0.5;

/** Only with AGENT_META_ALLOWED=yes and META_AGENT_CAP_USD above zero; nothing else switches Meta on. */
export function agentMetaFrom(env: NodeJS.ProcessEnv): MetaProvider | undefined {
  const cap = Number(env.META_AGENT_CAP_USD ?? "0");
  if (env.AGENT_META_ALLOWED !== "yes" || !(cap > 0)) return undefined;
  const capUsd = Math.min(cap, META_AGENT_CAP_MAX_USD);
  const daily = env.META_AGENT_DAILY_CAP_USD && /^\d+(\.\d+)?$/.test(env.META_AGENT_DAILY_CAP_USD) ? Number(env.META_AGENT_DAILY_CAP_USD) : META_AGENT_DAILY_CAP_DEFAULT_USD;
  return {
    baseUrl: (env.META_MODEL_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, ""),
    apiKey: env.META_MODEL_API_KEY || null,
    model: META_MODEL,
    capUsd,
    // META_AGENT_DAILY_CAP_USD can lower the daily ceiling, never raise it above the default.
    dailyCapUsd: Math.min(daily, META_AGENT_DAILY_CAP_DEFAULT_USD, capUsd),
  };
}

/**
 * What the chat names before its first answer: Meta Muse Spark (falling back to Nova Lite) when Meta is allowed
 * and has a key here, else Nova Lite. A word, never the key: this is what the drive page hands the browser.
 */
export const agentModelPlan = (env: NodeJS.ProcessEnv): ModelPlan => (agentMetaFrom(env)?.apiKey ? "meta" : "nova");
