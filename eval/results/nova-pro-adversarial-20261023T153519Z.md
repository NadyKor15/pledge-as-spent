# Receipt benchmark: nova-pro on adversarial

Run 20261023T153519Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 2.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 53.2 % / 84.7 % / 65.4 % (tp 50, fp 44, fn 9) |
| Line amount exact (by line number) | 62.7 % (37/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 72.7 % (8/11) / 63.6 % (7/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 66.8 % / 63.6 % (7/11) |
| Line class (verdict + need) | 52.6 % (30/57) |
| Need quantity exact (eligible lines) | 38.7 % (12/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 46.2 % (6/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 33.3 % (8/24) / n/a |
| Spend | 24 answered calls, 44194 in / 9082 out tokens, $0.0644 actual; ledger moved by $0.0644 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 3 of 11 (27.3 %) |
| out_of_zone | 100.0 % (2/2) | 4 of 11 (36.4 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":8,"zone_unknown":2}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 75.0 % | 75.0 % | 75.0 % | 100.0 % (2/2) |
| ja | 58.5 % | 43.2 % | 90.5 % | 100.0 % (4/4) |
| en | 91.4 % | 84.2 % | 100.0 % | 100.0 % (3/3) |
| tr | 41.4 % | 31.6 % | 60.0 % | 100.0 % (2/2) |

## Errors

- adv-unreadable-ja (read): read receipt (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at merchantName
✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
- adv-unreadable-tr (read): read receipt (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at merchantName
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
