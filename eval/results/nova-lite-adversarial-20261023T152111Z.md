# Receipt benchmark: nova-lite on adversarial

Run 20261023T152111Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 10.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 30.6 % / 18.6 % / 23.2 % (tp 11, fp 25, fn 48) |
| Line amount exact (by line number) | 8.5 % (5/59) |
| Receipt total exact | 27.3 % (3/11) |
| Date exact / date and time exact | 0.0 % (0/11) / 0.0 % (0/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 18.2 % / 18.2 % (2/11) |
| Line class (verdict + need) | 8.8 % (5/57) |
| Need quantity exact (eligible lines) | 3.2 % (1/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 0.0 % (0/13); funded by mistake: 1 |
| Personal data found / mean box overlap | 8.3 % (2/24) / 12.4 % |
| Spend | 13 answered calls, 33798 in / 7444 out tokens, $0.0038 actual; ledger moved by $0.0140 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 0.0 % (0/3) | 0 of 10 (0.0 %) |
| pre_disaster | 0.0 % (0/2) | 1 of 11 (9.1 %) |
| out_of_zone | 0.0 % (0/2) | 0 of 11 (0.0 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":3,"date_unknown":2,"zone_unknown":3}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 27.3 % | 30.0 % | 25.0 % | 50.0 % (1/2) |
| ja | 31.6 % | 35.3 % | 28.6 % | 25.0 % (1/4) |
| en | 0.0 % | n/a | 0.0 % | 0.0 % (0/3) |
| tr | 21.1 % | 22.2 % | 20.0 % | 50.0 % (1/2) |

## Errors

- adv-outofzone-ja (read): Model produced invalid sequence as part of ToolUse. Please refer to the model tool use troubleshooting guide.
- adv-predisaster-en (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[0].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[1].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[2].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[3].unitPriceMinor
✖ Invalid input: expected number, received null
  → at lines[4].amountMinor
✖ Invalid input: expected number, received null
  → at lines[5].amountMinor
✖ Invalid input: expected number, received null
  → at lines[6].amountMinor
✖ Invalid input: expected number, received null
  → at lines[7].amountMinor
✖ Invalid input: expected number, received null
  → at lines[8].amountMinor
✖ Invalid input: expected number, received null
  → at lines[9].amountMinor
✖ Invalid input: expected number, received null
  → at lines[10].amountMinor
✖ Invalid input: expected number, received null
  → at lines[11].amountMinor
✖ Invalid input: expected number, received null
  → at lines[12].amountMinor
✖ Invalid input: expected number, received null
  → at lines[13].amountMinor
✖ Invalid input: expected number, received null
  → at lines[14].amountMinor (stop reason: tool_use)
- adv-predisaster-ja (read): Model produced invalid sequence as part of ToolUse. Please refer to the model tool use troubleshooting guide.
- adv-reshot-en-03 (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at lines[4].amountMinor (stop reason: tool_use)
- adv-reshot-ja-04 (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at lines[1].lineNo
✖ Invalid input: expected number, received null
  → at lines[2].lineNo (stop reason: tool_use)
- adv-rules-en (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[0].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[0].amountMinor
✖ Invalid input: expected int, received number
  → at lines[1].amountMinor
✖ Invalid input: expected int, received number
  → at lines[2].amountMinor
✖ Invalid input: expected int, received number
  → at lines[3].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[3].amountMinor
✖ Invalid input: expected int, received number
  → at lines[4].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[4].amountMinor
✖ Invalid input: expected int, received number
  → at lines[5].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[5].amountMinor
✖ Invalid input: expected int, received number
  → at lines[7].amountMinor
✖ Invalid input: expected int, received number
  → at lines[8].amountMinor
✖ Invalid input: expected int, received number
  → at lines[9].amountMinor
✖ Invalid input: expected int, received number
  → at lines[10].amountMinor (stop reason: tool_use)
- adv-rules-es (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[0].amountMinor
✖ Invalid input: expected int, received number
  → at lines[1].amountMinor
✖ Invalid input: expected int, received number
  → at lines[2].amountMinor
✖ Invalid input: expected int, received number
  → at lines[3].amountMinor
✖ Invalid input: expected int, received number
  → at lines[4].amountMinor
✖ Invalid input: expected int, received number
  → at lines[5].amountMinor
✖ Invalid input: expected int, received number
  → at lines[8].amountMinor
✖ Invalid input: expected int, received number
  → at lines[9].amountMinor
✖ Invalid input: expected int, received number
  → at lines[10].amountMinor
✖ Invalid input: expected int, received number
  → at lines[11].amountMinor
✖ Invalid input: expected int, received number
  → at lines[12].amountMinor
✖ Invalid input: expected int, received number
  → at lines[13].amountMinor (stop reason: tool_use)
- adv-rules-tr (read): read receipt (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at lines[11].amountMinor
✖ Invalid input: expected number, received null
  → at lines[12].amountMinor (stop reason: tool_use)
- adv-unreadable-ja (read): Model produced invalid sequence as part of ToolUse. Please refer to the model tool use troubleshooting guide.
- adv-unreadable-tr (read): read receipt (amazon.nova-lite-v1:0): personal data "(illegible)" has no key=value fields (stop reason: tool_use)
