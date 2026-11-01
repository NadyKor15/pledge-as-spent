# Receipt benchmark: ocr-lite on adversarial

Run 20261101T002514Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 98.3 % / 99.1 % (tp 58, fp 0, fn 1) |
| Line amount exact (by line number) | 98.3 % (58/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 100.0 % (11/11) / 100.0 % (11/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 98.4 % / 100.0 % (11/11) |
| Line class (verdict + need) | 93.0 % (53/57) |
| Need quantity exact (eligible lines) | 77.4 % (24/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 92.3 % (12/13); funded by mistake: 0 |
| Personal data found by text / covered by a blur box / mean box overlap | 70.8 % (17/24) / 100.0 % (24/24) / 80.3 % |
| Median latency per receipt | reader 5109 ms; reader + classifier 6684 ms |
| Spend | 24 answered calls, 55250 in / 10737 out tokens, $0.0059 actual; ledger moved by $0.0059 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 100.0 % (3/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| out_of_zone | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| unreadable | 100.0 % (2/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":1,"date_unknown":2,"zone_unknown":2}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 100.0 % | 100.0 % | 100.0 % | 100.0 % (2/2) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (3/3) |
| tr | 94.7 % | 100.0 % | 90.0 % | 100.0 % (2/2) |
