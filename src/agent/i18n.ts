import type { AgentLocale } from "./money-parse";

// The chat's own sentences in the donor's language. The limit texts are STEP0 §2 word for word.

type Text = Record<AgentLocale, string>;

export const TEXT = {
  /** Questions per address or for everyone used up (STEP0 §2). */
  limit: {
    en: "The live AI has used today's questions. Every figure is still in the book below — tap a line to see it. The quick questions above keep working: the book's own code answers them.",
    de: "Die Live-KI hat ihre Fragen für heute verbraucht. Jede Zahl steht weiter im Buch unten — tippen Sie auf eine Zeile. Die Schnellfragen oben funktionieren weiter: Der Code des Buchs beantwortet sie selbst.",
    ja: "本日のライブAIの質問回数は上限に達しました。金額はすべて下の帳簿に残っています。行をタップすると確認できます。上の「よくある質問」は帳簿のコードがそのまま答えるので、引き続き使えます。",
  },
  /** Four questions an hour from one address. */
  hourly: {
    en: "Four questions an hour from one network — try again in a few minutes. The quick questions above keep working: the book's own code answers them.",
    de: "Vier Fragen pro Stunde aus einem Netz — versuchen Sie es in ein paar Minuten wieder. Die Schnellfragen oben funktionieren weiter: Der Code des Buchs beantwortet sie selbst.",
    ja: "同じネットワークからの質問は1時間に4回までです。数分後にもう一度お試しください。上の「よくある質問」は帳簿のコードが答えるので、引き続き使えます。",
  },
  /** The demo's money for live questions is used up. */
  budget: {
    en: "The demo's budget for live questions is used up for now. Every figure is still in the book below, and the quick questions above keep working: the book's own code answers them.",
    de: "Das Budget der Demo für Live-Fragen ist vorerst aufgebraucht. Jede Zahl steht weiter im Buch unten, und die Schnellfragen oben funktionieren weiter: Der Code des Buchs beantwortet sie selbst.",
    ja: "デモのライブ質問の予算は現在使い切りました。金額はすべて下の帳簿に残っています。上の「よくある質問」は帳簿のコードが答えるので、引き続き使えます。",
  },
  /** One question used its share of model calls. */
  tooLong: {
    en: "This question needed more steps than one question may take. Ask it more narrowly — for one donor or one line.",
    de: "Diese Frage brauchte mehr Schritte, als eine Frage nehmen darf. Fragen Sie enger — nach einer Person oder einer Zeile.",
    ja: "この質問は1回の質問で使える手順を超えました。寄付者1人や1行に絞って質問してください。",
  },
  /** The live AI is switched off on this server. */
  off: {
    en: "The live AI is switched off on this server. The quick questions above keep working: the book's own code answers them.",
    de: "Die Live-KI ist auf diesem Server ausgeschaltet. Die Schnellfragen oben funktionieren weiter: Der Code des Buchs beantwortet sie selbst.",
    ja: "このサーバーではライブAIがオフになっています。上の「よくある質問」は帳簿のコードが答えるので、引き続き使えます。",
  },
  /** The guard replaced an answer it could not confirm. */
  cannotConfirm: {
    en: "I can't confirm that figure from the book.",
    de: "Diesen Betrag kann ich im Buch nicht bestätigen.",
    ja: "その金額は帳簿で確認できません。",
  },
  /** Studio was rebuilt while the answer was on its way. */
  interrupted: {
    en: "The book changed while I was answering — ask again.",
    de: "Das Buch hat sich geändert, während ich geantwortet habe — fragen Sie bitte noch einmal.",
    ja: "回答中に帳簿が更新されました。もう一度質問してください。",
  },
  askAgain: { en: "Ask again", de: "Noch einmal fragen", ja: "もう一度質問する" },
  failed: {
    en: "The live AI did not answer. Try again, or use the quick questions above.",
    de: "Die Live-KI hat nicht geantwortet. Versuchen Sie es noch einmal oder nutzen Sie die Schnellfragen oben.",
    ja: "ライブAIから回答がありませんでした。もう一度試すか、上の「よくある質問」をお使いください。",
  },
} satisfies Record<string, Text>;

export type TextKey = keyof typeof TEXT;

export const say = (key: TextKey, locale: AgentLocale = "en"): string => TEXT[key][locale] ?? TEXT[key].en;
