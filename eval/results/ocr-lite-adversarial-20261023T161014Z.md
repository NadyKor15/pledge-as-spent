# Receipt benchmark: ocr-lite on adversarial

Run 20261023T161014Z. 13 receipts (11 scored on content; unreadable cases are scored on flags only). Reader errors: 4.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | 73.6 % / 66.1 % / 69.6 % (tp 39, fp 14, fn 20) |
| Line amount exact (by line number) | 47.5 % (28/59) |
| Receipt total exact | 81.8 % (9/11) |
| Date exact / date and time exact | 27.3 % (3/11) / 27.3 % (3/11) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 73.2 % / 63.6 % (7/11) |
| Line class (verdict + need) | 40.4 % (23/57) |
| Need quantity exact (eligible lines) | 16.1 % (5/31) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 53.8 % (7/13); funded by mistake: 0 |
| Personal data found / mean box overlap | 37.5 % (9/24) / 57.3 % |
| Median latency per receipt | reader 3297 ms; reader + classifier 4578 ms |
| Spend | 22 answered calls, 25580 in / 8178 out tokens, $0.0035 actual; ledger moved by $0.0035 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | 33.3 % (1/3) | 0 of 10 (0.0 %) |
| pre_disaster | 100.0 % (2/2) | 4 of 11 (36.4 %) |
| out_of_zone | 100.0 % (2/2) | 0 of 11 (0.0 %) |
| unreadable | 0.0 % (0/2) | 0 of 11 (0.0 %) |

Other review flags raised (not scored): {"total_mismatch":9}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| es | 37.5 % | 75.0 % | 25.0 % | 50.0 % (1/2) |
| ja | 88.4 % | 86.4 % | 90.5 % | 100.0 % (4/4) |
| en | 55.2 % | 61.5 % | 50.0 % | 66.7 % (2/3) |
| tr | 75.0 % | 64.3 % | 90.0 % | 100.0 % (2/2) |

## Errors

- adv-rules-en (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[0].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[2].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[3].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[6].unitPriceMinor
- adv-rules-es (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected int, received number
  → at lines[2].unitPriceMinor
✖ Invalid input: expected int, received number
  → at lines[8].unitPriceMinor
- adv-unreadable-ja (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received null
  → at totalMinor
- adv-unreadable-tr (read): ocr read (amazon.nova-lite-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at subtotalMinor
✖ Invalid input: expected number, received string
  → at taxMinor
✖ Invalid input: expected boolean, received string
  → at taxIncluded
✖ Invalid input: expected number, received string
  → at totalMinor
