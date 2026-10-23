# Receipt benchmark: recorded on adversarial

Run 20261023T144809Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 0.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 100.0 % / 100.0 % (tp 59, fp 0, fn 0) |
| Line amount exact (by line number) | 100.0 % (59/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 100.0 % (11/11) / 100.0 % (11/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 100.0 % / 100.0 % (11/11) |
| Line class (verdict + need) | 100.0 % (57/57) |
| Need quantity exact (eligible lines) | 100.0 % (31/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (13/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 100.0 % (24/24) / 100.0 % |
| Spend | 24 calls, 0 in / 0 out tokens, $0.0000 actual, $0.0000 ceiling |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 100.0 % (3/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| out_of_zone | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| unreadable | 100.0 % (2/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 100.0 % | 100.0 % | 100.0 % | 100.0 % (2/2) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (3/3) |
| tr | 100.0 % | 100.0 % | 100.0 % | 100.0 % (2/2) |
