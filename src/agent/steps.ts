import type { AgentLocale } from "./money-parse";

// What the chat says about a delegation to Studio's data agent. The model writes the delegation's
// instructions itself, so they are never shown: the reader sees a fixed sentence, picked by what
// the data agent actually ran.

/** "needSum": the data agent summed the book's Share by need; "query": anything else it was asked. */
export type DelegationStep = "needSum" | "query";

const TEXT: Record<DelegationStep, Record<AgentLocale, string>> = {
  needSum: {
    en: "Asked Studio's data agent to sum the book's Share by need",
    de: "Hat Studios Datenagenten gebeten, den Anteil (Share) im Buch je Bedarf zu summieren",
    ja: "Studioのデータエージェントに、帳簿の負担額（Share）を用途ごとに合計するよう依頼",
  },
  query: {
    en: "Asked Studio's data agent to look this up in the book",
    de: "Hat Studios Datenagenten gebeten, im Buch nachzusehen",
    ja: "Studioのデータエージェントに帳簿の確認を依頼",
  },
};

export function delegationText(step: DelegationStep, locale: AgentLocale): string {
  return TEXT[step][locale];
}

interface QueryShape {
  axes?: { dimensions?: { field?: { id?: unknown } }[] }[];
  measures?: { field?: { id?: unknown; aggregation?: unknown } }[];
}

/** An execute_query's `query` argument (an object, or the same as a JSON string) that sums Share per need. */
export function isNeedSumQuery(query: unknown): boolean {
  let q = query;
  if (typeof q === "string") {
    try {
      q = JSON.parse(q);
    } catch {
      return false;
    }
  }
  if (!q || typeof q !== "object") return false;
  const { axes, measures } = q as QueryShape;
  const byNeed = Array.isArray(axes) && axes.some((a) => Array.isArray(a?.dimensions) && a.dimensions.some((d) => d?.field?.id === "book.need"));
  const sumsShare = Array.isArray(measures) && measures.some((m) => m?.field?.id === "book.share" && m.field.aggregation === "sum");
  return byNeed && sumsShare;
}
