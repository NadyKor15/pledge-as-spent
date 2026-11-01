# Receipt benchmark: ocr-pro on holdout

Run 20261101T010436Z. 20 receipts (20 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 96.1 % / 95.1 % / 95.6 % (tp 98, fp 4, fn 5) |
| Line amount exact (by line number) | 94.2 % (97/103) |
| Receipt total exact | 100.0 % (20/20) |
| Date exact / date and time exact | 100.0 % (20/20) / 100.0 % (20/20) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 98.8 % / 100.0 % (20/20) |
| Line class (verdict + need) | 81.6 % (80/98) |
| Need quantity exact (eligible lines) | 63.3 % (38/60) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 90.0 % (9/10); funded by mistake: 0 |
| Personal data found by text / covered by a blur box / mean box overlap | 71.4 % (30/42) / 83.3 % (35/42) / 76.1 % |
| Median latency per receipt | reader 6602 ms; reader + classifier 8957 ms |
| Spend | 40 answered calls, 106482 in / 18792 out tokens, $0.1453 actual; ledger moved by $0.1453 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 20 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 20 (0.0 %) |
| out_of_zone | n/a (0/0) | 1 of 20 (5.0 %) |
| unreadable | n/a (0/0) | 0 of 20 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":3,"poor_quality":3}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| en | 94.4 % | 100.0 % | 89.5 % | 100.0 % (4/4) |
| es | 85.7 % | 85.7 % | 85.7 % | 100.0 % (4/4) |
| ja | 98.9 % | 97.8 % | 100.0 % | 100.0 % (8/8) |
| tr | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
