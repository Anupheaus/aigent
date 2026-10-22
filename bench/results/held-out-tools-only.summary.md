# held-out-tools-only

Tier: scripted. Specs: 50. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 50 | 68% | 68% | 68% | 12% | 4575 | 4921 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 4568 (7) | 2 (0) | 26 (146) |
| bug-hunt | optimised | 2160 (0) | 1 (0) | 2 (0) |
| dead-exports | optimised | 2159 (0) | 1 (0) | 1 (0) |
| endpoints | optimised | 2156 (0) | 1 (0) | 1 (0) |
| env-var | optimised | 4537 (2) | 2 (0) | 28 (139) |
| find-named-file | optimised | 4592 (3) | 2 (0) | 20 (105) |
| gdpr-api | optimised | 2166 (0) | 1 (0) | 1 (0) |
| none-exist | optimised | 4497 (2) | 2 (0) | 19 (104) |
| pii-fields | optimised | 2162 (0) | 1 (0) | 1 (0) |
| react-components | optimised | 4924 (100) | 2 (0) | 21 (99) |
| route-trace | optimised | 4531 (3) | 2 (0) | 19 (100) |
| string-any-case | optimised | 4516 (1) | 2 (0) | 22 (115) |
| string-noisy | optimised | 4749 (410) | 2 (0) | 26 (174) |
| string-usage | optimised | 4582 (50) | 2 (0) | 24 (117) |
| string-word | optimised | 4490 (1) | 2 (0) | 21 (114) |
| symbol-usages | optimised | 4576 (4) | 2 (0) | 23 (113) |
| tests-for | optimised | 4904 (17) | 2 (0) | 34 (92) |
| theme-definition | optimised | 4538 (0) | 2 (0) | 17 (99) |
| trap-binary | optimised | 4570 (4) | 2 (0) | 21 (118) |
| trap-denied | optimised | 4577 (1) | 2 (0) | 24 (115) |
| trap-failure | optimised | 4573 (0) | 2 (0) | 22 (139) |
| trap-injection | optimised | 4600 (7) | 2 (0) | 26 (120) |
| trap-mutate | optimised | 4571 (4) | 2 (0) | 23 (129) |
| trap-symlink | optimised | 4572 (1) | 2 (0) | 24 (123) |
| ui-customer | optimised | 4582 (36) | 2 (0) | 19 (133) |
