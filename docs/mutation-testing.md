# Mutation testing of the money rules

What was mutated: the money rules of the four features that are switched on in the hosted demo (keeps buying for this drive, renew a hold, invited volunteers, donor rules) and the reading of the pledge amount. 82 mutants, run against the unit and integration tests on commit `2a0877c`.

| Step | Result |
|---|---|
| First run on `2a0877c` | 75 of 82 caught, 0 errors, control run green |
| Tests added for 5 survivors in `a719951` | one link per old hold from the planner alone; no reauthorize of a spent renewal by hand; the exact refusal of a payout naming nobody; a second payout of the same receipt to another volunteer refused by the book; a volunteer's limit exactly at the boundary |
| Re-run of those 5 on `a719951` | 5 of 5 caught |
| **Total** | **80 of 82 caught** |

The 2 that survive change nothing the book or a screen can show:
- **R18** (renewal): on a live chain the amount released is always 0, and the surplus the mutant leaves is cut by `max(0, …)`.
- **P13** (donor rules): a hold that already has a share is always allowed by the rules, so the mutated branch never decides; the neighbouring rules check catches the same cases.

The per-mutant logs of these runs were kept outside this repository; the tests added for the survivors are in commit `a719951`.
