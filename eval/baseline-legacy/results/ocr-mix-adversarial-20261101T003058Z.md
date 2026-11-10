# Receipt benchmark: ocr-mix on adversarial

Run 20261101T003058Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 1.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 93.2 % / 96.5 % (tp 55, fp 0, fn 4) |
| Line amount exact (by line number) | 93.2 % (55/59) |
| Receipt total exact | 90.9 % (10/11) |
| Date exact / date and time exact | 90.9 % (10/11) / 90.9 % (10/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 89.3 % / 90.9 % (10/11) |
| Line class (verdict + need) | 93.0 % (53/57) |
| Need quantity exact (eligible lines) | 80.6 % (25/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (13/13); funded by mistake: 0 |
| Personal data found by text / covered by a blur box / mean box overlap | 70.8 % (17/24) / 100.0 % (24/24) / 80.3 % |
| Median latency per receipt | reader 5496 ms; reader + classifier 7095 ms |
| Spend | 23 answered calls, 53337 in / 10223 out tokens, $0.0540 actual; ledger moved by $0.0540 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 100.0 % (3/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| out_of_zone | 50.0 % (1/2) | 0 of 11 (0.0 %) |
| unreadable | 100.0 % (2/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"poor_quality":2,"total_mismatch":1,"date_unknown":2,"zone_unknown":2}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 85.7 % | 100.0 % | 75.0 % | 50.0 % (1/2) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (3/3) |
| tr | 94.7 % | 100.0 % | 90.0 % | 100.0 % (2/2) |

## Errors

- adv-outofzone-es (read): ocr read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at taxMinor
