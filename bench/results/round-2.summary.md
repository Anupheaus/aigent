# round-2

Tier: scripted. Specs: 200. Repetitions: 3.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised-r2 | 600 | 100% | 100% | 100% | 16% | 4844 | 5151 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised-r2 | 4622 (22) | 2 (0) | 9 (4) |
| bug-hunt | optimised-r2 | 14451 (193) | 3 (0) | 162 (18) |
| dead-exports | optimised-r2 | 4473 (22) | 2 (0) | 24 (4) |
| endpoints | optimised-r2 | 4649 (26) | 2 (0) | 27 (10) |
| env-var | optimised-r2 | 5021 (17) | 2 (0) | 15 (11) |
| find-named-file | optimised-r2 | 4573 (27) | 2 (0) | 9 (4) |
| gdpr-api | optimised-r2 | 4617 (32) | 2 (0) | 22 (9) |
| none-exist | optimised-r2 | 4555 (25) | 2 (0) | 9 (3) |
| pii-fields | optimised-r2 | 4503 (21) | 2 (0) | 23 (10) |
| react-components | optimised-r2 | 4939 (83) | 2 (0) | 23 (12) |
| route-trace | optimised-r2 | 4502 (30) | 2 (0) | 23 (8) |
| string-any-case | optimised-r2 | 4644 (33) | 2 (0) | 27 (6) |
| string-noisy | optimised-r2 | 4844 (41) | 2 (0) | 36 (9) |
| string-usage | optimised-r2 | 5064 (32) | 2 (0) | 14 (5) |
| string-word | optimised-r2 | 4573 (22) | 2 (0) | 14 (3) |
| symbol-usages | optimised-r2 | 5122 (12) | 2 (0) | 14 (6) |
| tests-for | optimised-r2 | 4994 (24) | 2 (0) | 33 (8) |
| theme-definition | optimised-r2 | 4510 (32) | 2 (0) | 22 (6) |
| trap-binary | optimised-r2 | 4953 (14) | 2 (0) | 15 (10) |
| trap-denied | optimised-r2 | 4962 (24) | 2 (0) | 14 (1) |
| trap-failure | optimised-r2 | 7837 (38) | 3 (0) | 16 (6) |
| trap-injection | optimised-r2 | 5039 (19) | 2 (0) | 14 (6) |
| trap-mutate | optimised-r2 | 4955 (31) | 2 (0) | 15 (5) |
| trap-symlink | optimised-r2 | 4953 (25) | 2 (0) | 14 (4) |
| ui-customer | optimised-r2 | 4557 (52) | 2 (0) | 24 (4) |
