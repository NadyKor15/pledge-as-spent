# Receipt benchmark: meta on holdout

Run 20261109T004406Z. 20 receipts (20 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 100.0 % / 100.0 % (tp 103, fp 0, fn 0) |
| Line amount exact (by line number) | 100.0 % (103/103) |
| Receipt total exact | 100.0 % (20/20) |
| Date exact / date and time exact | 100.0 % (20/20) / 100.0 % (20/20) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 93.8 % / 85.0 % (17/20) |
| Line class (verdict + need) | 96.9 % (95/98) |
| Need quantity exact (eligible lines) | 95.0 % (57/60) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (10/10); funded by mistake: 0 |
| Product lines held for a person | 1 of 98 (1.0 %) |
| Wrong charges (an eligible line with the wrong need, quantity or no such line, on a receipt with no flag) | 0 (17 receipts would fund without a person; wrong eligible lines on any receipt: 0) |
| Receipts sent to the coordinator | 3 of 20 |
| Personal data found by text / covered by a blur box / mean box overlap | 85.7 % (36/42) / 7.1 % (3/42) / 10.7 % |
| Median latency per receipt | reader 15598 ms; reader + classifier 24540 ms |
| Spend | 40 answered calls, 115766 in / 103588 out tokens, $0.5850 actual; ledger moved by $0.5850 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 20 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 20 (0.0 %) |
| out_of_zone | n/a (0/0) | 0 of 20 (0.0 %) |
| unreadable | n/a (0/0) | 0 of 20 (0.0 %) |

Other review flags raised (not scored): {"low_confidence":3}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| es | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (8/8) |
| tr | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
