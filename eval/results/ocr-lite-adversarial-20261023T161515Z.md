# Receipt benchmark: ocr-lite on adversarial

Run 20261023T161515Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 2.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 68.8 % / 89.8 % / 77.9 % (tp 53, fp 24, fn 6) |
| Line amount exact (by line number) | 57.6 % (34/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 36.4 % (4/11) / 36.4 % (4/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 90.8 % / 81.8 % (9/11) |
| Line class (verdict + need) | 66.7 % (38/57) |
| Need quantity exact (eligible lines) | 22.6 % (7/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 92.3 % (12/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 54.2 % (13/24) / 64.1 % |
| Median latency per receipt | reader 3277 ms; reader + classifier 5496 ms |
| Spend | 24 answered calls, 28508 in / 9308 out tokens, $0.0039 actual; ledger moved by $0.0039 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 50.0 % (1/2) | 5 of 11 (45.5 %) |
| out_of_zone | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":10}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 88.0 % | 84.6 % | 91.7 % | 100.0 % (2/2) |
| ja | 84.4 % | 79.2 % | 90.5 % | 100.0 % (4/4) |
| en | 73.2 % | 60.0 % | 93.8 % | 100.0 % (3/3) |
| tr | 64.0 % | 53.3 % | 80.0 % | 100.0 % (2/2) |

## Errors

- adv-unreadable-ja (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor
- adv-unreadable-tr (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at subtotalMinor
✖ Invalid input: expected number, received string
  → at taxMinor
✖ Invalid input: expected number, received string
  → at totalMinor
