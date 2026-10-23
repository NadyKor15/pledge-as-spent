# Receipt benchmark: nova-pro-2pass on hero

Run 20261023T160242Z. 1 receipts (1 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 53.3 % / 72.7 % / 61.5 % (tp 8, fp 7, fn 3) |
| Line amount exact (by line number) | 9.1 % (1/11) |
| Receipt total exact | 100.0 % (1/1) |
| Date exact / date and time exact | 100.0 % (1/1) / 100.0 % (1/1) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 0.0 % / 0.0 % (0/1) |
| Line class (verdict + need) | 0.0 % (0/11) |
| Need quantity exact (eligible lines) | 0.0 % (0/9) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 0.0 % (0/2); funded by mistake: 0 |
| Personal data found / mean box overlap | 0.0 % (0/3) / n/a |
| Median latency per receipt | reader 13850 ms; reader + classifier 58861 ms |
| Spend | 2 answered calls, 6392 in / 1701 out tokens, $0.0106 actual; ledger moved by $0.0106 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 1 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 1 (0.0 %) |
| out_of_zone | n/a (0/0) | 1 of 1 (100.0 %) |
| unreadable | n/a (0/0) | 0 of 1 (0.0 %) |

Other review flags raised (not scored): {"poor_quality":1,"total_mismatch":1}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| ja | 61.5 % | 53.3 % | 72.7 % | 100.0 % (1/1) |
