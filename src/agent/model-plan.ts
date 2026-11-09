import type { AgentLocale } from "./money-parse";

/**
 * Whether the server can answer live, known before any question: "meta" when Meta Muse Spark, the agent's only
 * model, is allowed and has a key on the server, else "off". Only this word reaches the browser, never the key
 * (src/server/agent-env.ts agentModelPlan).
 */
export type ModelPlan = "meta" | "off";

export const META_MUSE_SPARK = "Meta Muse Spark";
const OFF: Record<AgentLocale, string> = { en: "Live AI off", de: "Live-KI aus", ja: "ライブAIはオフ" };

/** The chat's small print until the server names the model that answered: "Meta Muse Spark". */
export const planLabel = (plan: ModelPlan, locale: AgentLocale = "en"): string => (plan === "meta" ? META_MUSE_SPARK : (OFF[locale] ?? OFF.en));
