# held-out-reference

Tier: scripted. Specs: 50. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 50 | 68% | 68% | 68% | 0% | 3850 | 7600 | 2 | 3 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | reference | 3489 (4) | 2 (0) | 13 (73) |
| bug-hunt | reference | 1592 (0) | 1 (0) | 1 (0) |
| dead-exports | reference | 1591 (0) | 1 (0) | 1 (0) |
| endpoints | reference | 1588 (0) | 1 (0) | 1 (0) |
| env-var | reference | 3866 (14) | 2 (0) | 15 (84) |
| find-named-file | reference | 3443 (2) | 2 (0) | 8 (48) |
| gdpr-api | reference | 1598 (0) | 1 (0) | 1 (0) |
| none-exist | reference | 3425 (3) | 2 (0) | 8 (49) |
| pii-fields | reference | 1594 (0) | 1 (0) | 1 (0) |
| react-components | reference | 5045 (247) | 2 (0) | 14 (80) |
| route-trace | reference | 16197 (45) | 5 (0) | 49 (289) |
| string-any-case | reference | 3689 (3) | 2 (0) | 12 (75) |
| string-noisy | reference | 4353 (1828) | 2 (0) | 30 (207) |
| string-usage | reference | 3938 (121) | 2 (0) | 13 (75) |
| string-word | reference | 3603 (2) | 2 (0) | 12 (72) |
| symbol-usages | reference | 3977 (4) | 2 (0) | 13 (73) |
| tests-for | reference | 3850 (13) | 2 (0) | 27 (176) |
| theme-definition | reference | 7600 (4) | 3 (0) | 70 (455) |
| trap-binary | reference | 3826 (0) | 2 (0) | 13 (73) |
| trap-denied | reference | 3839 (1) | 2 (0) | 13 (76) |
| trap-failure | reference | 6166 (5) | 3 (0) | 14 (96) |
| trap-injection | reference | 3911 (13) | 2 (0) | 13 (74) |
| trap-mutate | reference | 3825 (12) | 2 (0) | 13 (83) |
| trap-symlink | reference | 3828 (6) | 2 (0) | 16 (113) |
| ui-customer | reference | 3676 (41) | 2 (0) | 13 (66) |
