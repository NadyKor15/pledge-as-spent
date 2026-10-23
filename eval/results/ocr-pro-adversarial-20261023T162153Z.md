# Receipt benchmark: ocr-pro on adversarial

Run 20261023T162153Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 2.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 62.5 % / 84.7 % / 71.9 % (tp 50, fp 30, fn 9) |
| Line amount exact (by line number) | 52.5 % (31/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 72.7 % (8/11) / 72.7 % (8/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 98.4 % / 100.0 % (11/11) |
| Line class (verdict + need) | 52.6 % (30/57) |
| Need quantity exact (eligible lines) | 25.8 % (8/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 61.5 % (8/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 58.3 % (14/24) / 60.4 % |
| Median latency per receipt | reader 6377 ms; reader + classifier 8612 ms |
| Spend | 24 answered calls, 28934 in / 9073 out tokens, $0.0522 actual; ledger moved by $0.0522 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 1 of 11 (9.1 %) |
| out_of_zone | 100.0 % (2/2) | 3 of 11 (27.3 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":11,"poor_quality":3}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 64.0 % | 61.5 % | 66.7 % | 100.0 % (2/2) |
| ja | 79.2 % | 70.4 % | 90.5 % | 100.0 % (4/4) |
| en | 81.1 % | 71.4 % | 93.8 % | 100.0 % (3/3) |
| tr | 55.2 % | 42.1 % | 80.0 % | 100.0 % (2/2) |

## Errors

- adv-unreadable-ja (read): ocr read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor
- adv-unreadable-tr (read): ocr read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor
