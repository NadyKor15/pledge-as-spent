import { factFor } from "../../src/agent/guard";
import { extractClaims, type AgentLocale, type Claim } from "../../src/agent/money-parse";
import { donorFigures, donorHold, ledgerDonorMoney, ledgerLine, ledgerPaypalIds, ledgerRefusals, ledgerTotals } from "../../src/agent/tools";
import type { Fact } from "../../src/agent/types";
import type { DriveView } from "../../src/ui/types";

// The measure of the live agent (rule 84): seven donor questions on the closed demo drive. What a
// right answer must say is computed here from the book, by the same code as the tools — not typed by
// hand. A right answer: every required figure is in it, the guard did not have to step in, and it
// states no figure outside what the relevant tools returned.

export interface EvalQuestion {
  id: string;
  locale: AgentLocale;
  text: string;
  /** Figures the answer must state. */
  required: Fact[];
  /** Figures it may state besides them. */
  allowed: Fact[];
  /** Words the answer must use (the reason for a refusal). */
  words?: RegExp[];
  /** The agent is expected to ask Studio's data agent. */
  delegates?: boolean;
}

const amount = (currency: string, minor: number, label: string): Fact => ({ value: currency === "JPY" ? minor : minor / 100, currency, label });
const id = (x: string | null | undefined, label: string): Fact => ({ value: 0, id: x ?? "", label });

function money(v: DriveView, who: string) {
  const d = donorFigures(v, donorHold(v, who)!);
  return {
    d,
    spent: amount(d.currency, d.spent, "spent"),
    back: amount(d.currency, d.back, "back"),
    lines: d.rows.map((r) => amount(d.currency, (r.amount ?? 0) - (r.reversed ?? 0), `line ${r.lineNo}`)),
    captures: d.captures.map((c) => id(c.id, "capture")),
  };
}

export function evalQuestions(v: DriveView): EvalQuestion[] {
  const mark = money(v, "Mark");
  const lena = money(v, "Lena");
  const yuki = money(v, "Yuki");
  const refused = v.ledger.filter((r) => r.kind === "rejected");
  const water = v.needs.find((n) => n.needId === "water")!;
  const waterRows = v.ledger.filter((r) => r.needId === "water");
  const facts = (...rs: { data: { facts: Fact[] } }[]) => rs.flatMap((r) => r.data.facts);
  const yukiIds = [id(yuki.d.hold.orderId, "order"), id(yuki.d.hold.authorizationId, "authorization"), ...yuki.captures];
  return [
    {
      id: "Q1",
      locale: "en",
      text: "I'm Mark from Columbus. What did my money buy?",
      required: [mark.spent, ...mark.lines, ...mark.captures, mark.back],
      allowed: facts(ledgerDonorMoney(v, "Mark"), ledgerPaypalIds(v, "Mark")),
    },
    {
      id: "Q2",
      locale: "en",
      text: "Why was a line refused?",
      required: refused.map((r) => amount(v.drive.baseCurrency, r.base, `line ${r.lineNo}`)),
      allowed: facts(ledgerRefusals(v), ...refused.map((r) => ledgerLine(v, `${r.receiptId}:${r.lineNo}`))),
      words: [/alcohol|beer/i, /gift card/i],
    },
    {
      id: "Q3",
      locale: "en",
      text: "I'm Lena from Berlin. How much came back to me?",
      required: [lena.back, lena.spent],
      allowed: facts(ledgerDonorMoney(v, "Lena")),
    },
    {
      id: "Q4",
      locale: "en",
      text: "I'm Yuki from Osaka. What are my PayPal numbers?",
      required: yukiIds,
      allowed: facts(ledgerPaypalIds(v, "Yuki"), ledgerDonorMoney(v, "Yuki")),
    },
    {
      id: "Q5",
      locale: "en",
      text: "How much went to water across all donors?",
      required: [amount(v.drive.baseCurrency, water.fundedBase, "water, all shares")],
      allowed: [
        amount(v.drive.baseCurrency, water.donorBase, "water, donors"),
        amount(v.drive.baseCurrency, water.matchBase, "water, match"),
        ...waterRows.map((r) => amount(v.drive.baseCurrency, r.base, `line ${r.lineNo} share`)),
        ...facts(ledgerTotals(v), ledgerDonorMoney(v, "Lena")),
      ],
      delegates: true,
    },
    {
      id: "Q6",
      locale: "de",
      text: "Ich bin Lena aus Berlin. Wie viel Geld ist zu mir zurückgekommen, und wie viel wurde ausgegeben?",
      required: [lena.back, lena.spent],
      allowed: facts(ledgerDonorMoney(v, "Lena")),
    },
    {
      id: "Q7",
      locale: "ja",
      text: "大阪のユキです。私のPayPalの番号を教えてください。",
      required: yukiIds,
      allowed: facts(ledgerPaypalIds(v, "Yuki"), ledgerDonorMoney(v, "Yuki")),
    },
  ];
}

export interface Score {
  id: string;
  correct: boolean;
  missing: string[];
  extra: string[];
  missingWords: string[];
  guardFired: boolean;
  delegated: boolean;
}

const show = (f: Fact) => (f.id ? f.id : `${f.currency ?? ""} ${f.value}`);

/** Whether one answer is right, by the rules above. */
export function scoreAnswer(q: EvalQuestion, a: { text: string; retried: boolean; replaced: boolean; delegated?: readonly string[] }): Score {
  const claims: Claim[] = extractClaims(a.text, q.locale);
  const missing = q.required.filter((r) => !claims.some((c) => (r.id ? c.id === r.id : c.kind === "amount" && factFor(c, [r]) !== undefined))).map(show);
  const pool = [...q.required, ...q.allowed];
  const extra = claims.filter((c) => !factFor(c, pool)).map((c) => c.raw.trim());
  const missingWords = (q.words ?? []).filter((w) => !w.test(a.text)).map(String);
  const guardFired = a.retried || a.replaced;
  return { id: q.id, correct: !missing.length && !extra.length && !missingWords.length && !guardFired, missing, extra, missingWords, guardFired, delegated: (a.delegated?.length ?? 0) > 0 };
}
