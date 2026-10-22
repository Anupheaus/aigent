# round-3-tools-only

Tier: scripted. Specs: 200. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 200 | 100% | 100% | 100% | 20% | 4569 | 4912 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 4573 (24) | 2 (0) | 23 (15) |
| bug-hunt | optimised | 10910 (139) | 3 (0) | 67 (18) |
| dead-exports | optimised | 4501 (25) | 2 (0) | 19 (2) |
| endpoints | optimised | 4665 (23) | 2 (0) | 19 (7) |
| env-var | optimised | 4544 (15) | 2 (0) | 23 (3) |
| find-named-file | optimised | 4583 (29) | 2 (0) | 18 (8) |
| gdpr-api | optimised | 4635 (32) | 2 (0) | 19 (3) |
| none-exist | optimised | 4482 (29) | 2 (0) | 19 (2) |
| pii-fields | optimised | 4522 (22) | 2 (0) | 18 (3) |
| react-components | optimised | 4912 (42) | 2 (0) | 19 (9) |
| route-trace | optimised | 4528 (30) | 2 (0) | 21 (6) |
| string-any-case | optimised | 4619 (33) | 2 (0) | 24 (2) |
| string-noisy | optimised | 4760 (40) | 2 (0) | 27 (8) |
| string-usage | optimised | 4575 (32) | 2 (0) | 23 (5) |
| string-word | optimised | 4526 (26) | 2 (0) | 26 (19) |
| symbol-usages | optimised | 4598 (26) | 2 (0) | 25 (4) |
| tests-for | optimised | 4915 (17) | 2 (0) | 22 (5) |
| theme-definition | optimised | 4528 (30) | 2 (0) | 19 (2) |
| trap-binary | optimised | 4557 (25) | 2 (0) | 23 (3) |
| trap-denied | optimised | 4561 (22) | 2 (0) | 29 (11) |
| trap-failure | optimised | 4559 (25) | 2 (0) | 24 (3) |
| trap-injection | optimised | 4586 (27) | 2 (0) | 22 (3) |
| trap-mutate | optimised | 4559 (24) | 2 (0) | 23 (3) |
| trap-symlink | optimised | 4560 (25) | 2 (0) | 22 (4) |
| ui-customer | optimised | 4550 (31) | 2 (0) | 18 (7) |
