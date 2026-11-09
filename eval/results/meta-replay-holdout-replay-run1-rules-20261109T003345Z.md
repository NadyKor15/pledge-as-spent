# Receipt benchmark: meta-replay on holdout

Run 20261109T003345Z. 20 receipts (20 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 100.0 % / 100.0 % (tp 103, fp 0, fn 0) |
| Line amount exact (by line number) | 100.0 % (103/103) |
| Receipt total exact | 100.0 % (20/20) |
| Date exact / date and time exact | 100.0 % (20/20) / 100.0 % (20/20) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 95.8 % / 90.0 % (18/20) |
| Line class (verdict + need) | 92.9 % (91/98) |
| Need quantity exact (eligible lines) | 88.3 % (53/60) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (10/10); funded by mistake: 0 |
| Product lines held for a person | 6 of 98 (6.1 %) |
| Wrong charges (an eligible line with the wrong need, quantity or no such line, on a receipt with no flag) | 0 (14 receipts would fund without a person; wrong eligible lines on any receipt: 0) |
| Receipts sent to the coordinator | 6 of 20 |
| Personal data found by text / covered by a blur box / mean box overlap | 85.7 % (36/42) / 9.5 % (4/42) / 11.2 % |
| Median latency per receipt | reader 0 ms; reader + classifier 0 ms |
| Spend | 40 answered calls, 0 in / 0 out tokens, $0.0000 actual; ledger moved by n/a (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 20 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 20 (0.0 %) |
| out_of_zone | n/a (0/0) | 0 of 20 (0.0 %) |
| unreadable | n/a (0/0) | 0 of 20 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":4,"low_confidence":4}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| es | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (8/8) |
| tr | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
