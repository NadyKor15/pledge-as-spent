import type { AgentLocale } from "./money-parse";

/**
 * Which model the server is set to answer with, known before any question: "meta" when Meta Muse Spark is
 * allowed and has a key on the server (Amazon Nova Lite answers whatever Meta cannot), else "nova". Only this
 * word reaches the browser, never the key (src/server/agent-env.ts agentModelPlan).
 */
export type ModelPlan = "meta" | "nova";

const NOVA_LITE = "Amazon Nova Lite";
const FALLS_BACK: Record<AgentLocale, string> = { en: "falls back to", de: "ersatzweise", ja: "予備は" };

/** The chat's small print until the server names the model that answered: "Meta Muse Spark · falls back to Amazon Nova Lite". */
export const planLabel = (plan: ModelPlan, locale: AgentLocale = "en"): string => (plan === "meta" ? `Meta Muse Spark · ${FALLS_BACK[locale]} ${NOVA_LITE}` : NOVA_LITE);
