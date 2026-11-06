// Shapes shared by the book's tools, the guard, the harness and the chat widget.

import type { ShareTopic } from "./money-parse";

export type { AgentLocale } from "./money-parse";

/** One figure a tool of the book returned. Amounts are in major units: 21.45 for $21.45, 1237 for ¥1,237. */
export interface Fact {
  value: number;
  currency?: string;
  /** What the figure is, in the tool's words ("Mark's share of line 4"). */
  label: string;
  /** The book line the figure belongs to, when it belongs to one. */
  lineKey?: string;
  /** Every book line behind a total (a donor's spend, a need's spend). */
  lineKeys?: string[];
  /** A PayPal id (order, authorization, capture, payout batch). */
  id?: string;
  /** "%": a share, in percent (22.9 for €4.58 of €20.00), not money. */
  unit?: "%";
  /** What a share is of: the pledge spent, the pledge back or held, the spend PayPal took, a need covered. */
  topic?: ShareTopic;
}

export type { ShareTopic } from "./money-parse";

/** What a tool of the book hands back: the sentence the model reads, and the figures behind it. */
export interface LedgerToolResult {
  text: string;
  data: { facts: Fact[]; lineKeys: string[]; [key: string]: unknown };
}
