import type { Statement, StatementView } from "@/ui/types";

type Row = Statement["rows"][number];

const row = (r: Partial<Row> & Pick<Row, "lineNo" | "qty" | "status"> & { minor: number; shareBase: number }): Row => ({
  receiptId: "demo-f372326129.r1",
  needId: "water",
  item: "Drinking water 2 L",
  unit: "bottle 2 L",
  matchBase: r.shareBase,
  captureId: null,
  requestId: null,
  reversed: 0,
  uncollectedReason: null,
  honored: true,
  at: "2026-11-01T02:06:01.717Z",
  ...r,
  share: { currency: "EUR", minor: r.minor },
});

/** A donor in euros whose drive is in yen: every share state the statement can show. */
const rows: Row[] = [
  row({ lineNo: 1, qty: 6, status: "captured", minor: 246, shareBase: 399, captureId: "3WP65983GD053501C", requestId: "demo-f372326129:capture:1" }),
  row({ lineNo: 2, qty: 4, status: "captured", minor: 145, shareBase: 236, captureId: "3WP65983GD053501C", requestId: "demo-f372326129:capture:1" }),
  row({ lineNo: 3, qty: 2, status: "partly_reversed", minor: 67, shareBase: 108, captureId: "3WP65983GD053501C", requestId: "demo-f372326129:capture:1", reversed: 30 }),
  row({ lineNo: 1, receiptId: "demo-f372326129.r2", needId: "batteries", item: "AA batteries", unit: "pack of 4", qty: 3, status: "uncollected", minor: 120, shareBase: 195, uncollectedReason: "hold_expired", honored: false, at: "2026-11-02T09:00:00.000Z" }),
  row({ lineNo: 2, receiptId: "demo-f372326129.r2", needId: "batteries", item: "AA batteries", unit: "pack of 4", qty: 1, status: "capture_pending", minor: 40, shareBase: 65, requestId: "demo-f372326129:capture:2", at: "2026-11-02T09:01:00.000Z" }),
  row({ lineNo: 3, receiptId: "demo-f372326129.r2", needId: "batteries", item: "=HYPERLINK(\"http://evil.example\")", unit: "pack of 4", qty: 1, status: "accrued", minor: 40, shareBase: 65, at: "2026-11-02T09:02:00.000Z" }),
];

const sum = (pick: (r: Row) => number) => rows.reduce((a, r) => a + pick(r), 0);
const captured = (r: Row) => r.status === "captured" || r.status === "partly_reversed" || r.status === "reversed";

export const lenaStatement: StatementView = {
  drive: { id: "demo-f372326129", title: "Kitasora flood relief (demo)" },
  statement: {
    pledgeId: "demo-f372326129.water",
    donorName: "Lena (Berlin) & \"Partners\" <GmbH>",
    baseCurrency: "JPY",
    currency: "EUR",
    rows,
    totals: {
      shareBase: sum((r) => r.shareBase),
      share: sum((r) => r.share.minor),
      charged: sum((r) => (captured(r) ? r.share.minor - r.reversed : 0)),
      uncollected: sum((r) => (r.status === "uncollected" ? r.share.minor : 0)),
      reversed: sum((r) => r.reversed),
      matchBase: sum((r) => r.matchBase),
      helpBase: sum((r) => r.shareBase + r.matchBase),
    },
    balance: {
      pledgeId: "demo-f372326129.water",
      kind: "donor",
      donorName: "Lena (Berlin)",
      needId: "water",
      status: "partially_captured",
      revoked: false,
      currency: "EUR",
      pledged: 2000,
      authorized: 2000,
      captured: 458,
      capturePending: 40,
      accrued: 40,
      released: 0,
      uncollected: 120,
      reversed: 30,
      available: 1342,
      capacityBase: 0,
      blocked: false,
      blockedReason: null,
      authorizationId: "2Y816602392541815",
      expiresAt: "2026-11-30T02:05:45.000Z",
    },
  },
};
