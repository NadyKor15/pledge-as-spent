# Receipt benchmark: meta on adversarial

Run 20261109T002345Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 2.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 100.0 % / 100.0 % / 100.0 % (tp 59, fp 0, fn 0) |
| Line amount exact (by line number) | 100.0 % (59/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 100.0 % (11/11) / 100.0 % (11/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 92.8 % / 81.8 % (9/11) |
| Line class (verdict + need) | 100.0 % (57/57) |
| Need quantity exact (eligible lines) | 100.0 % (31/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 100.0 % (13/13); funded by mistake: 0 |
| Product lines held for a person | 0 of 57 (0.0 %) |
| Wrong charges (an eligible line with the wrong need, quantity or no such line, on a receipt with no flag) | 0 (4 receipts would fund without a person; wrong eligible lines on any receipt: 0) |
| Receipts sent to the coordinator | 7 of 13 |
| Personal data found by text / covered by a blur box / mean box overlap | 87.5 % (21/24) / 0.0 % (0/24) / 0.0 % |
| Median latency per receipt | reader 15374 ms; reader + classifier 25140 ms |
| Spend | 24 answered calls, 66238 in / 56016 out tokens, $0.3209 actual; ledger moved by $0.3209 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 100.0 % (3/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| out_of_zone | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":2,"low_confidence":1}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 100.0 % | 100.0 % | 100.0 % | 100.0 % (2/2) |
| ja | 100.0 % | 100.0 % | 100.0 % | 100.0 % (4/4) |
| en | 100.0 % | 100.0 % | 100.0 % | 100.0 % (3/3) |
| tr | 100.0 % | 100.0 % | 100.0 % | 100.0 % (2/2) |

## Errors

- adv-unreadable-ja (read): read A (whole photo): output does not match the schema: ✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor
- adv-unreadable-tr (read): read A (whole photo): output does not match the schema: ✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor
