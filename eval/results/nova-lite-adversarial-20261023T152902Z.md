# Receipt benchmark: nova-lite on adversarial

Run 20261023T152902Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 3.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 45.6 % / 69.5 % / 55.0 % (tp 41, fp 49, fn 18) |
| Line amount exact (by line number) | 35.6 % (21/59) |
| Receipt total exact | 72.7 % (8/11) |
| Date exact / date and time exact | 63.6 % (7/11) / 54.5 % (6/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 62.6 % / 63.6 % (7/11) |
| Line class (verdict + need) | 31.6 % (18/57) |
| Need quantity exact (eligible lines) | 19.4 % (6/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 38.5 % (5/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 25.0 % (6/24) / 34.1 % |
| Spend | 24 answered calls, 43869 in / 9137 out tokens, $0.0048 actual; ledger moved by $0.0048 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 4 of 11 (36.4 %) |
| out_of_zone | 100.0 % (2/2) | 5 of 11 (45.5 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":10}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 30.8 % | 28.6 % | 33.3 % | 100.0 % (2/2) |
| ja | 55.4 % | 40.9 % | 85.7 % | 75.0 % (3/4) |
| en | 75.0 % | 75.0 % | 75.0 % | 100.0 % (3/3) |
| tr | 53.8 % | 43.8 % | 70.0 % | 0.0 % (0/2) |

## Errors

- adv-reshot-tr-02 (classify): classify lines (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid option: expected one of "alcohol"|"tobacco"|"gift_card"|"not_in_needs"|"other_rule"|"unclear"
  → at [1].ruleCode (stop reason: tool_use)
- adv-unreadable-ja (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at merchantName
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
- adv-unreadable-tr (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at merchantName
✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
