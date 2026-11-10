# Receipt benchmark: nova-lite on adversarial

Run 20261023T154416Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 5.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 41.6 % / 54.2 % / 47.1 % (tp 32, fp 45, fn 27) |
| Line amount exact (by line number) | 40.7 % (24/59) |
| Receipt total exact | 72.7 % (8/11) |
| Date exact / date and time exact | 63.6 % (7/11) / 54.5 % (6/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 45.5 % / 45.5 % (5/11) |
| Line class (verdict + need) | 15.8 % (9/57) |
| Need quantity exact (eligible lines) | 16.1 % (5/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 7.7 % (1/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 20.8 % (5/24) / 32.3 % |
| Spend | 22 answered calls, 41590 in / 8463 out tokens, $0.0045 actual; ledger moved by $0.0045 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 2 of 11 (18.2 %) |
| out_of_zone | 100.0 % (2/2) | 4 of 11 (36.4 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":7}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 9.1 % | 10.0 % | 8.3 % | 50.0 % (1/2) |
| ja | 43.8 % | 32.6 % | 66.7 % | 75.0 % (3/4) |
| en | 93.8 % | 93.8 % | 93.8 % | 100.0 % (3/3) |
| tr | 22.2 % | 25.0 % | 20.0 % | 50.0 % (1/2) |

## Errors

- adv-rules-es (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[2].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[2].amountMinor
✖ Invalid input: expected int, received number
  → at lines[9].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[9].amountMinor (stop reason: end_turn)
- adv-rules-ja (classify): classify lines (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [6].verdict
✖ Invalid input: expected number, received null
  → at [6].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [7].verdict
✖ Invalid input: expected number, received null
  → at [7].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [8].verdict
✖ Invalid input: expected number, received null
  → at [8].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [9].verdict
✖ Invalid input: expected number, received null
  → at [9].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [10].verdict
✖ Invalid input: expected number, received null
  → at [10].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [11].verdict
✖ Invalid input: expected number, received null
  → at [11].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [12].verdict
✖ Invalid input: expected number, received null
  → at [12].confidence
✖ Invalid option: expected one of "eligible"|"rejected"|"review"
  → at [13].verdict
✖ Invalid input: expected number, received null
  → at [13].confidence (stop reason: tool_use)
- adv-rules-tr (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[2].unitPriceMinor (stop reason: end_turn)
- adv-unreadable-ja (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
- adv-unreadable-tr (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected string, received null
  → at currency
✖ Invalid input: expected number, received null
  → at totalMinor (stop reason: end_turn)
