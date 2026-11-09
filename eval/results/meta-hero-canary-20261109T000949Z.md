# Receipt benchmark: meta on hero

Run 20261109T000949Z. 1 receipts (1 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 100.0 % / 100.0 % (tp 11, fp 0, fn 0) |
| Line amount exact (by line number) | 100.0 % (11/11) |
| Receipt total exact | 100.0 % (1/1) |
| Date exact / date and time exact | 100.0 % (1/1) / 100.0 % (1/1) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 100.0 % / 100.0 % (1/1) |
| Line class (verdict + need) | 100.0 % (11/11) |
| Need quantity exact (eligible lines) | 100.0 % (9/9) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (2/2); funded by mistake: 0 |
| Product lines held for a person | 0 of 11 (0.0 %) |
| Wrong charges (an eligible line with the wrong need, quantity or no such line, on a receipt with no flag) | 0 (1 receipts would fund without a person; wrong eligible lines on any receipt: 0) |
| Receipts sent to the coordinator | 0 of 1 |
| Personal data found by text / covered by a blur box / mean box overlap | 66.7 % (2/3) / 0.0 % (0/3) / n/a |
| Median latency per receipt | reader 23541 ms; reader + classifier 34264 ms |
| Spend | 2 answered calls, 7821 in / 6470 out tokens, $0.0373 actual; ledger moved by $0.0373 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 1 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 1 (0.0 %) |
| out_of_zone | n/a (0/0) | 0 of 1 (0.0 %) |
| unreadable | n/a (0/0) | 0 of 1 (0.0 %) |

Other review flags raised (not scored): {}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (1/1) |
