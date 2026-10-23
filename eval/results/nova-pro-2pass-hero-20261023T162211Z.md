# Receipt benchmark: nova-pro-2pass on hero

Run 20261023T162211Z. 1 receipts (1 scored on content; unreadable cases are scored on flags only). Reader errors: 1.

| Metric | Result |
|---|---|
| Line precision / recall / F1 | n/a / 0.0 % / 0.0 % (tp 0, fp 0, fn 11) |
| Line amount exact (by line number) | 0.0 % (0/11) |
| Receipt total exact | 0.0 % (0/1) |
| Date exact / date and time exact | 0.0 % (0/1) / 0.0 % (0/1) |
| Merchant (fuzzy) mean similarity / at least 0.8 | 0.0 % / 0.0 % (0/1) |
| Line class (verdict + need) | 0.0 % (0/11) |
| Need quantity exact (eligible lines) | 0.0 % (0/9) |
| Rule lines rejected with the right code (alcohol, tobacco, gift card) | 0.0 % (0/2); funded by mistake: 0 |
| Personal data found / mean box overlap | 0.0 % (0/3) / n/a |
| Median latency per receipt | reader 14381 ms; reader + classifier 14381 ms |
| Spend | 1 answered calls, 5024 in / 1270 out tokens, $0.0081 actual; ledger moved by $0.0081 (failed calls stay reserved at their ceiling) |

## Fraud flags

| Flag | Recall | False alarms |
|---|---|---|
| duplicate | n/a (0/0) | 0 of 1 (0.0 %) |
| pre_disaster | n/a (0/0) | 0 of 1 (0.0 %) |
| out_of_zone | n/a (0/0) | 0 of 1 (0.0 %) |
| unreadable | n/a (0/0) | 0 of 1 (0.0 %) |

Other review flags raised (not scored): {}

## By language

| Language | Line F1 | Precision | Recall | Total exact |
|---|---|---|---|---|
| ja | 0.0 % | n/a | 0.0 % | 0.0 % (0/1) |

## Errors

- hero-ja-01 (read): two-pass read (amazon.nova-pro-v1:0): output does not match the schema: ✖ Invalid input: expected number, received string
  → at lines[18].qty
