# Receipt benchmark: nova-pro on adversarial

Run 20261023T155019Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 3.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 58.8 % / 84.7 % / 69.4 % (tp 50, fp 35, fn 9) |
| Line amount exact (by line number) | 69.5 % (41/59) |
| Receipt total exact | 100.0 % (11/11) |
| Date exact / date and time exact | 72.7 % (8/11) / 63.6 % (7/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 65.3 % / 63.6 % (7/11) |
| Line class (verdict + need) | 49.1 % (28/57) |
| Need quantity exact (eligible lines) | 38.7 % (12/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 53.8 % (7/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 29.2 % (7/24) / 55.6 % |
| Spend | 24 answered calls, 43943 in / 8501 out tokens, $0.0624 actual; ledger moved by $0.0624 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 3 of 11 (27.3 %) |
| out_of_zone | 100.0 % (2/2) | 3 of 11 (27.3 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":9,"zone_unknown":2}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 75.0 % | 75.0 % | 75.0 % | 100.0 % (2/2) |
| ja | 64.3 % | 51.4 % | 85.7 % | 100.0 % (4/4) |
| en | 91.4 % | 84.2 % | 100.0 % | 100.0 % (3/3) |
| tr | 48.3 % | 36.8 % | 70.0 % | 100.0 % (2/2) |

## Errors

- adv-rules-ja (classify): classify lines (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at [11].confidence (stop reason: tool_use)
- adv-unreadable-ja (read): read receipt (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
- adv-unreadable-tr (read): read receipt (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
