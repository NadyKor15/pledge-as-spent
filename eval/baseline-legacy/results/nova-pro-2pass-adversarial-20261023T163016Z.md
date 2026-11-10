# Receipt benchmark: nova-pro-2pass on adversarial

Run 20261023T163016Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 5.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 59.4 % / 64.4 % / 61.8 % (tp 38, fp 26, fn 21) |
| Line amount exact (by line number) | 28.8 % (17/59) |
| Receipt total exact | 72.7 % (8/11) |
| Date exact / date and time exact | 72.7 % (8/11) / 72.7 % (8/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 63.1 % / 63.6 % (7/11) |
| Line class (verdict + need) | 52.6 % (30/57) |
| Need quantity exact (eligible lines) | 22.6 % (7/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 76.9 % (10/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 12.5 % (3/24) / n/a |
| Median latency per receipt | reader 8356 ms; reader + classifier 9730 ms |
| Spend | 21 answered calls, 56328 in / 14949 out tokens, $0.0929 actual; ledger moved by $0.0929 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| out_of_zone | 50.0 % (1/2) | 4 of 11 (36.4 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":7,"poor_quality":1}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 66.7 % | 60.0 % | 75.0 % | 100.0 % (2/2) |
| ja | 20.7 % | 37.5 % | 14.3 % | 25.0 % (1/4) |
| en | 78.0 % | 64.0 % | 100.0 % | 100.0 % (3/3) |
| tr | 76.9 % | 62.5 % | 100.0 % | 100.0 % (2/2) |

## Errors

- adv-outofzone-ja (read): two-pass read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at lines[8].qty
- adv-reshot-ja-04 (read): two-pass read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at lines[5].amountMinor
✖ Invalid input: expected number, received string
  → at lines[6].amountMinor
- adv-rules-ja (read): two-pass read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at lines[1].qty
✖ Invalid input: expected number, received string
  → at lines[3].unitPriceMinor
✖ Invalid input: expected number, received string
  → at lines[6].unitPriceMinor
- adv-unreadable-ja (read): two-pass read (amazon.nova-pro-v1:0): structure: the answer was cut off (stop reason: max_tokens)
- adv-unreadable-tr (read): two-pass read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor
