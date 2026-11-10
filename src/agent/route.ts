import { shownHolds } from "@/ui/derive";
import { donorParts } from "@/ui/format";
import type { DriveView, Hold } from "@/ui/types";
import { norm, withAliases } from "./tools";

// Variant C of the live agent: before the model's first turn the book's code reads the question,
// finds the donor and what is asked, and runs the right tool itself (Studio's `defaultToolCalls`).
// The model then only writes the answer from facts already in the conversation. A sum over one need
// is delegated to Studio's data agent, whose query is also run by code. What the code does not
// recognise goes the usual way: the model picks the tools.

export type Intent = "money" | "back" | "paypal" | "refused" | "needSum";

export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface RoutePlan {
  intent: Intent;
  /** The hold's donor name ("Mark (Columbus)"), for a donor's question. */
  donor?: string;
  needId?: string;
  /** Run by code before our agent's first turn. */
  calls: ToolCall[];
  /** Run by code before the data agent's first turn, when the plan delegates to it. */
  dataCalls?: ToolCall[];
}

/** Every need's sum of shares, as Studio's data engine adds them up. */
export const NEED_SUM_QUERY = { variant: "aggregation", kind: "apiQuery", axes: [{ dimensions: [{ field: { id: "book.need" } }] }], measures: [{ field: { id: "book.share", aggregation: "sum" } }] };

const NEED_SUM_INSTRUCTIONS = "The book's code has already run execute_query for the sum of the book's Share field per need. Report each need's sum exactly as the query returned it, then call complete_task.";

// Cues per intent, EN / DE / JA. Order of the checks below decides overlaps:
// a need sum first, then refusals, then a donor's PayPal numbers, money back, money spent.
const CUES: Record<Exclude<Intent, "needSum">, RegExp> = {
  refused: /refus|reject|declin|not funded|turned down|abgelehnt|abgewiesen|nicht finanziert|却下|拒否|断られ|対象外/i,
  paypal: /paypal[\s-]*(number|nummer|id|reference)|\b(order|authori[sz]ation|capture|transaction)s?\b|nummern|bestellnummer|autorisierung|番号|オーソリ|売上確定|注文/i,
  back: /came back|come back|back to me|get back|got back|returned|refund|released|never charged|not charged|zurück|erstattet|freigegeben|nie belastet|nicht belastet|戻|返|請求されず|請求されなかった/i,
  money: /what did .*buy|money buy|bought|pay for|paid for|spent|spend|where did .*go|wofür|gekauft|bezahlt|ausgegeben|買|何に使|使われ|支払/i,
};

const ALL_DONORS = /across all|all donors|all the donors|everyone|altogether|in total|in all\b|alle spender|insgesamt|zusammen|全体|合計|すべての寄付者|全員|みんな|全部で/i;

/** Words that name each need, besides its own label: the demo's needs in three languages. */
const NEED_WORDS: Record<string, RegExp> = {
  water: /water|wasser|水/i,
  diapers: /diaper|nappy|nappies|windel|おむつ|オムツ/i,
  batteries: /batter|batterie|電池/i,
};

function needIn(v: DriveView, text: string): string | null {
  for (const n of v.needs) {
    const own = [n.needId, ...n.label.split(/\s+/), ...n.displayLabel.split(/\s+/)].filter((w) => w.length >= 4).map((w) => w.toLowerCase());
    if (NEED_WORDS[n.needId]?.test(text) || own.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text))) return n.needId;
  }
  return null;
}

/** The one hold whose donor's name or city the question says, word for word (Japanese forms included). */
function donorIn(v: DriveView, text: string): Hold | null {
  const words = new Set(
    norm(withAliases(text))
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2),
  );
  // A renewed donor is one donor: their two holds would make two hits (renewal-chain.ts).
  const hits = shownHolds(v).filter((h) => {
    if (h.kind !== "donor") return false;
    const { name, place } = donorParts(h.donorName, h.donorCountry);
    const city = (place ?? "").split(",")[0];
    return [name, city].some((x) => x && norm(x).split(/\s+/).every((w) => words.has(w)));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** What the code runs before the model answers, or null to leave the question to the model. */
export function routeQuestion(v: DriveView, text: string): RoutePlan | null {
  const t = text.normalize("NFKC");
  const donor = donorIn(v, t);
  const needId = needIn(v, t);
  if (needId && (ALL_DONORS.test(t) || !donor)) {
    return {
      intent: "needSum",
      needId,
      calls: [{ tool: "delegate_to", args: { type: { id: "data" }, instructions: NEED_SUM_INSTRUCTIONS } }],
      dataCalls: [{ tool: "view_schema" }, { tool: "execute_query", args: { query: NEED_SUM_QUERY } }],
    };
  }
  if (CUES.refused.test(t)) return { intent: "refused", calls: [{ tool: "ledger_refusals" }] };
  if (!donor) return null;
  const who = donor.donorName;
  if (CUES.paypal.test(t)) return { intent: "paypal", donor: who, calls: [{ tool: "ledger_paypal_ids", args: { who } }] };
  if (CUES.back.test(t)) return { intent: "back", donor: who, calls: [{ tool: "ledger_donor_money", args: { donor: who } }] };
  if (CUES.money.test(t)) return { intent: "money", donor: who, calls: [{ tool: "ledger_donor_money", args: { donor: who } }] };
  return null;
}
