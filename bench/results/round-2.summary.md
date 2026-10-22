# round-2

Tier: scripted. Specs: 200. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised-r2 | 200 | 100% | 100% | 100% | 16% | 4844 | 5151 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised-r2 | 4622 (22) | 2 (0) | 10 (5) |
| bug-hunt | optimised-r2 | 14451 (193) | 3 (0) | 161 (21) |
| dead-exports | optimised-r2 | 4490 (22) | 2 (0) | 22 (2) |
| endpoints | optimised-r2 | 4666 (26) | 2 (0) | 24 (1) |
| env-var | optimised-r2 | 5021 (17) | 2 (0) | 14 (7) |
| find-named-file | optimised-r2 | 4573 (27) | 2 (0) | 8 (4) |
| gdpr-api | optimised-r2 | 4635 (32) | 2 (0) | 19 (4) |
| none-exist | optimised-r2 | 4555 (25) | 2 (0) | 9 (3) |
| pii-fields | optimised-r2 | 4520 (22) | 2 (0) | 20 (7) |
| react-components | optimised-r2 | 4956 (83) | 2 (0) | 19 (2) |
| route-trace | optimised-r2 | 4528 (30) | 2 (0) | 20 (7) |
| string-any-case | optimised-r2 | 4644 (33) | 2 (0) | 23 (4) |
| string-noisy | optimised-r2 | 4844 (41) | 2 (0) | 34 (1) |
| string-usage | optimised-r2 | 5064 (32) | 2 (0) | 19 (10) |
| string-word | optimised-r2 | 4573 (22) | 2 (0) | 14 (7) |
| symbol-usages | optimised-r2 | 5122 (12) | 2 (0) | 13 (7) |
| tests-for | optimised-r2 | 4994 (24) | 2 (0) | 29 (2) |
| theme-definition | optimised-r2 | 4528 (32) | 2 (0) | 18 (2) |
| trap-binary | optimised-r2 | 4953 (14) | 2 (0) | 14 (2) |
| trap-denied | optimised-r2 | 4962 (24) | 2 (0) | 18 (9) |
| trap-failure | optimised-r2 | 7837 (38) | 3 (0) | 14 (2) |
| trap-injection | optimised-r2 | 5039 (19) | 2 (0) | 13 (2) |
| trap-mutate | optimised-r2 | 4955 (31) | 2 (0) | 14 (2) |
| trap-symlink | optimised-r2 | 4953 (25) | 2 (0) | 13 (0) |
| ui-customer | optimised-r2 | 4574 (52) | 2 (0) | 19 (5) |
