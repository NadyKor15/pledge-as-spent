import { bookRefusals } from "@/ui/derive";
import { decimals, money } from "@/ui/format";
import type { DriveView } from "@/ui/types";
import { checkAnswer, type Verdict } from "./guard";
import type { AgentLocale } from "./money-parse";
import { donorFigures, donorHold, ledgerDonorMoney, ledgerPaypalIds, ledgerRefusals, type DonorFigures } from "./tools";
import type { Fact } from "./types";

// The quick questions, answered by the book's own code: the same tool the agent calls, then a
// sentence template in EN/DE/JA. No model, so they keep working when the live AI is out of
// questions or budget, and they cost nothing.

export type StarterId = "money" | "refused" | "back" | "paypal";

export interface Starter {
  id: StarterId;
  label: Record<AgentLocale, string>;
  /** Whose money: the donor must be named first. */
  needsDonor: boolean;
}

export const STARTERS: readonly Starter[] = [
  { id: "money", needsDonor: true, label: { en: "What did my money buy?", de: "Was hat mein Geld gekauft?", ja: "私のお金で何が買われましたか？" } },
  { id: "refused", needsDonor: false, label: { en: "Why was a line refused?", de: "Warum wurde eine Zeile abgelehnt?", ja: "なぜ却下された行がありますか？" } },
  { id: "back", needsDonor: true, label: { en: "How much was never charged?", de: "Wie viel wurde nie belastet?", ja: "いくらが請求されずに済みましたか？" } },
  { id: "paypal", needsDonor: true, label: { en: "My PayPal numbers", de: "Meine PayPal-Nummern", ja: "私のPayPal番号" } },
];

/** The prompt a starter sends to the live agent, for a harness's promptStarters. */
export function starterPrompt(id: StarterId, locale: AgentLocale, donor?: string): string {
  const s = STARTERS.find((x) => x.id === id)!;
  const who = donor ? { en: `I'm ${donor}. `, de: `Ich bin ${donor}. `, ja: `${donor}です。` }[locale] : "";
  return `${who}${s.label[locale]}`;
}

/** Money as the donor's language writes it: "$21.45" / "21,45 $" / "￥1,237". The guard reads all three. */
export function localMoney(currency: string, minor: number, locale: AgentLocale): string {
  if (locale === "en") return money(currency, minor);
  const d = decimals(currency);
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "ja-JP", { style: "currency", currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
}

function list(items: string[], locale: AgentLocale): string {
  if (items.length <= 1) return items.join("");
  const and = { en: " and ", de: " und ", ja: "、" }[locale];
  return `${items.slice(0, -1).join(locale === "ja" ? "、" : ", ")}${and}${items[items.length - 1]}`;
}

const NEED_NAME: Record<string, Record<AgentLocale, string>> = {
  water: { en: "drinking water", de: "Trinkwasser", ja: "飲料水" },
  diapers: { en: "baby diapers size M", de: "Babywindeln Größe M", ja: "Mサイズのおむつ" },
  batteries: { en: "AA batteries", de: "AA-Batterien", ja: "単3電池" },
};
const needName = (n: { needId: string; label: string }, locale: AgentLocale) => NEED_NAME[n.needId]?.[locale] ?? n.label;

const RULE: Record<string, Record<AgentLocale, { name: string; why: string }>> = {
  alcohol: { en: { name: "alcohol", why: "alcohol is never funded" }, de: { name: "Alkohol", why: "Alkohol wird nie finanziert" }, ja: { name: "アルコール", why: "アルコールは対象外です" } },
  tobacco: { en: { name: "tobacco", why: "tobacco is never funded" }, de: { name: "Tabak", why: "Tabak wird nie finanziert" }, ja: { name: "たばこ", why: "たばこは対象外です" } },
  gift_card: { en: { name: "a gift card", why: "gift cards are never funded" }, de: { name: "Geschenkkarte", why: "Geschenkkarten werden nie finanziert" }, ja: { name: "ギフトカード", why: "ギフトカードは対象外です" } },
};

export interface CodeAnswer {
  text: string;
  facts: Fact[];
  lineKeys: string[];
  verdict: Verdict;
  /** Set when the book could not answer (no such donor). */
  missing?: boolean;
}

function moneyAnswer(d: DonorFigures, l: AgentLocale): string {
  const m = (minor: number) => localMoney(d.currency, minor, l);
  const lines = d.rows.map((x) => m(x.status === "uncollected" ? 0 : (x.amount ?? 0) - (x.reversed ?? 0)));
  // One need: its amount is the amount spent, said once. Several: each with its own.
  const needs = list(d.needs.map((n) => (d.needs.length > 1 ? `${needName(n, l)} (${m(n.own)})` : needName(n, l))), l);
  const caps = list(d.captures.map((c) => c.id), l);
  if (d.spent === 0) {
    return { en: `Your ${m(d.pledged)} hold has not paid for any line yet.`, de: `Ihr Hold über ${m(d.pledged)} hat noch keine Zeile bezahlt.`, ja: `${m(d.pledged)}の仮押さえはまだどの行にも使われていません。` }[l];
  }
  const rest = d.over
    ? { en: ` The other ${m(d.back)} was never charged: PayPal released it${d.closed ? " when the drive closed" : ""}.`, de: ` Die übrigen ${m(d.back)} wurden nie belastet: PayPal hat sie${d.closed ? " beim Abschluss der Sammlung" : ""} freigegeben.`, ja: ` 残りの${m(d.back)}は請求されず、${d.closed ? "募金の終了時に" : ""}PayPalが解放しました。` }[l]
    : { en: ` ${m(d.held)} is still held for the drive.`, de: ` ${m(d.held)} sind weiter für die Sammlung reserviert.`, ja: ` ${m(d.held)}は引き続き募金のために確保されています。` }[l];
  const capture = caps
    ? { en: ` PayPal took it in ${d.captures.length === 1 ? "one capture" : "these captures"}, ${caps}.`, de: ` PayPal hat es mit ${d.captures.length === 1 ? "einer Abbuchung" : "diesen Abbuchungen"} eingezogen: ${caps}.`, ja: ` PayPalの売上確定は${caps}です。` }[l]
    : "";
  return {
    en: `Your ${m(d.pledged)} hold paid ${m(d.spent)} for ${needs}: ${d.rows.length} line${d.rows.length === 1 ? "" : "s"}, ${list(lines, l)}.${capture}${rest}`,
    de: `Ihr Hold über ${m(d.pledged)} hat ${m(d.spent)} für ${needs} bezahlt: ${d.rows.length} Zeile${d.rows.length === 1 ? "" : "n"}, ${list(lines, l)}.${capture}${rest}`,
    ja: `${m(d.pledged)}の仮押さえから、${needs}に${m(d.spent)}が支払われました（${d.rows.length}行：${list(lines, l)}）。${capture.trim()}${rest.trim()}`,
  }[l];
}

// "Never charged" only where it is true: the hold is over by a void or an expiry and nothing was refunded after a
// capture (the same rule as LedgerDonor.neverCharged). A refund came back after a charge; a void PayPal has not
// answered yet is on its way back. Every figure is one the guard already has (spent, held, back, pledged).
function backAnswer(d: DonorFigures, l: AgentLocale): string {
  const m = (minor: number) => localMoney(d.currency, minor, l);
  const refunded = d.hold.reversed > 0;
  if (!d.over) {
    const extra =
      d.back <= 0
        ? { en: "", de: "", ja: "" }
        : refunded
          ? { en: ` ${m(d.back)} was charged, then refunded.`, de: ` ${m(d.back)} wurden belastet und dann erstattet.`, ja: `${m(d.back)}は請求後に返金されました。` }
          : { en: ` ${m(d.back)} is on its way back at PayPal.`, de: ` ${m(d.back)} sind bei PayPal auf dem Rückweg.`, ja: `${m(d.back)}はPayPalで解放処理中です。` };
    return {
      en: `So far ${m(d.spent)} went to needs; ${m(d.held)} is still held for the drive and has not been charged.${extra.en}`,
      de: `Bisher gingen ${m(d.spent)} an den Bedarf; ${m(d.held)} sind weiter für die Sammlung reserviert und nicht belastet.${extra.de}`,
      ja: `これまでに${m(d.spent)}が必要な物資に使われ、${m(d.held)}は引き続き募金のために確保されていて、請求されていません。${extra.ja}`,
    }[l];
  }
  if (refunded) {
    return {
      en: `${m(d.back)} of your ${m(d.pledged)} came back to you, part of it as a refund after it was charged. ${m(d.spent)} was spent on needs.`,
      de: `${m(d.back)} Ihrer ${m(d.pledged)} sind zu Ihnen zurückgekommen, teils als Erstattung nach der Abbuchung. ${m(d.spent)} wurden für den Bedarf ausgegeben.`,
      ja: `${m(d.pledged)}のうち${m(d.back)}が戻りました（一部は請求後の返金です）。${m(d.spent)}は必要な物資に使われました。`,
    }[l];
  }
  if (d.hold.status === "voided" || d.hold.status === "expired") {
    return {
      en: `${m(d.back)} of your ${m(d.pledged)} was never charged: PayPal released the hold${d.closed ? " when the drive closed" : ""}. ${m(d.spent)} was spent on needs.`,
      de: `${m(d.back)} Ihrer ${m(d.pledged)} wurden nie belastet: PayPal hat die Reservierung${d.closed ? " beim Abschluss der Sammlung" : ""} freigegeben. ${m(d.spent)} wurden für den Bedarf ausgegeben.`,
      ja: `${m(d.pledged)}のうち${m(d.back)}は請求されず、${d.closed ? "募金の終了時に" : ""}PayPalが仮押さえを解放しました。${m(d.spent)}は必要な物資に使われました。`,
    }[l];
  }
  if (d.back > 0) {
    return {
      en: `${m(d.back)} of your ${m(d.pledged)} is on its way back at PayPal: the hold is being released. ${m(d.spent)} was spent on needs.`,
      de: `${m(d.back)} Ihrer ${m(d.pledged)} sind bei PayPal auf dem Rückweg: die Reservierung wird freigegeben. ${m(d.spent)} wurden für den Bedarf ausgegeben.`,
      ja: `${m(d.pledged)}のうち${m(d.back)}はPayPalで解放処理中です。${m(d.spent)}は必要な物資に使われました。`,
    }[l];
  }
  return {
    en: `${m(d.spent)} of your ${m(d.pledged)} was spent on needs; nothing is left on the hold.`,
    de: `${m(d.spent)} Ihrer ${m(d.pledged)} wurden für den Bedarf ausgegeben; auf der Reservierung ist nichts mehr übrig.`,
    ja: `${m(d.pledged)}のうち${m(d.spent)}が必要な物資に使われ、仮押さえに残りはありません。`,
  }[l];
}

function paypalAnswer(d: DonorFigures, l: AgentLocale): string {
  const m = (minor: number) => localMoney(d.currency, minor, l);
  const h = d.hold;
  const caps = d.captures.map((c) => ({ en: `${m(c.own)} in capture ${c.id}`, de: `${m(c.own)} mit Abbuchung ${c.id}`, ja: `売上確定${c.id}で${m(c.own)}` })[l]);
  return {
    en: `Your PayPal order is ${h.orderId}, the hold (authorization) is ${h.authorizationId}${caps.length ? `, and PayPal took ${list(caps, l)}` : ", and PayPal has taken nothing yet"}.`,
    de: `Ihre PayPal-Bestellung ist ${h.orderId}, die Reservierung (Autorisierung) ${h.authorizationId}${caps.length ? `; PayPal hat ${list(caps, l)} eingezogen` : "; PayPal hat noch nichts eingezogen"}.`,
    ja: `PayPalの注文番号は${h.orderId}、仮押さえ（オーソリ）は${h.authorizationId}です。${caps.length ? `${list(caps, l)}が確定しました。` : "まだ売上確定はありません。"}`,
  }[l];
}

function refusedAnswer(v: DriveView, l: AgentLocale): string {
  const base = v.drive.baseCurrency;
  // The same refusals, count and total as the screens and ledger_refusals (bookRefusals), in the drive's currency.
  const { items: refusals, count, total: sum } = bookRefusals(v);
  const m = (minor: number) => localMoney(base, minor, l);
  if (refusals.length === 0) return { en: "No line of this book was refused.", de: "In diesem Buch wurde keine Zeile abgelehnt.", ja: "この帳簿で却下された行はありません。" }[l];
  const items = refusals.map((i) => {
    const no = i.line.lineNo;
    const amount = i.base!; // bookRefusals keeps only items with an amount in the drive's currency
    if (i.countedWith !== undefined) {
      const off = m(-amount);
      return { en: `line ${no}, a discount of ${off} counted with line ${i.countedWith}`, de: `Zeile ${no}, Rabatt von ${off}, mit Zeile ${i.countedWith} verrechnet`, ja: `${no}行目の値引き（${off}）：${i.countedWith}行目と一緒に計上` }[l];
    }
    const r = i.row?.code ? RULE[i.row.code]?.[l] : undefined;
    // A reason is one clause of the list: its own full stop would print "needs.; line 3" and "needs..".
    const why = (r?.why ?? i.row?.reasonEn ?? "").trim().replace(/[.。!！]+$/u, "");
    return { en: `line ${no}, ${r?.name ?? "an item"} for ${m(amount)}: ${why}`, de: `Zeile ${no}, ${r?.name ?? "ein Artikel"} für ${m(amount)}: ${why}`, ja: `${no}行目の${r?.name ?? "品目"}（${m(amount)}）：${why}` }[l];
  });
  const total = m(sum);
  return {
    en: `${count} line${count === 1 ? " was" : "s were"} refused, ${total} in total, and no donor paid for ${count === 1 ? "it" : "them"}: ${items.join("; ")}.`,
    de: `${count} Zeile${count === 1 ? " wurde" : "n wurden"} abgelehnt, insgesamt ${total}; kein Spender hat dafür bezahlt: ${items.join("; ")}.`,
    ja: `却下された行は${count}行、合計${total}で、寄付者の支払いはありません：${items.join("。")}。`,
  }[l];
}

/** A quick question answered by the book's code. `donor` is a name or city; null for one that needs none. */
export function answerStarter(v: DriveView, id: StarterId, donor: string | null, locale: AgentLocale): CodeAnswer {
  if (id === "refused") {
    const tool = ledgerRefusals(v);
    const text = refusedAnswer(v, locale);
    return { text, facts: tool.data.facts, lineKeys: tool.data.lineKeys, verdict: checkAnswer(text, tool.data.facts, locale) };
  }
  const hold = donor ? donorHold(v, donor) : null;
  if (!hold) {
    const text = { en: "Who are you in the book? Pick your name below.", de: "Wer sind Sie im Buch? Wählen Sie unten Ihren Namen.", ja: "帳簿のどなたですか？下からお名前を選んでください。" }[locale];
    return { text, facts: [], lineKeys: [], verdict: checkAnswer(text, [], locale), missing: true };
  }
  const d = donorFigures(v, hold);
  // The same tool the agent calls supplies the figures the guard checks against.
  const tool = id === "paypal" ? ledgerPaypalIds(v, hold.donorName) : ledgerDonorMoney(v, hold.donorName);
  const facts = id === "paypal" ? [...tool.data.facts, ...ledgerDonorMoney(v, hold.donorName).data.facts] : tool.data.facts;
  const text = id === "money" ? moneyAnswer(d, locale) : id === "back" ? backAnswer(d, locale) : paypalAnswer(d, locale);
  return { text, facts, lineKeys: d.lineKeys, verdict: checkAnswer(text, facts, locale) };
}
