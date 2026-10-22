# held-out

Tier: scripted. Specs: 50. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 50 | 68% | 68% | 68% | 12% | 3453 | 3799 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 3446 (7) | 2 (0) | 27 (152) |
| bug-hunt | optimised | 1599 (0) | 1 (0) | 2 (0) |
| dead-exports | optimised | 1598 (0) | 1 (0) | 1 (0) |
| endpoints | optimised | 1595 (0) | 1 (0) | 1 (1) |
| env-var | optimised | 3415 (2) | 2 (0) | 27 (140) |
| find-named-file | optimised | 3470 (3) | 2 (0) | 20 (110) |
| gdpr-api | optimised | 1605 (0) | 1 (0) | 1 (0) |
| none-exist | optimised | 3375 (2) | 2 (0) | 20 (102) |
| pii-fields | optimised | 1601 (0) | 1 (0) | 1 (0) |
| react-components | optimised | 3802 (100) | 2 (0) | 21 (104) |
| route-trace | optimised | 3409 (3) | 2 (0) | 19 (102) |
| string-any-case | optimised | 3394 (1) | 2 (0) | 22 (117) |
| string-noisy | optimised | 3627 (410) | 2 (0) | 27 (171) |
| string-usage | optimised | 3460 (50) | 2 (0) | 22 (119) |
| string-word | optimised | 3368 (1) | 2 (0) | 22 (117) |
| symbol-usages | optimised | 3454 (4) | 2 (0) | 22 (115) |
| tests-for | optimised | 3782 (17) | 2 (0) | 33 (91) |
| theme-definition | optimised | 3416 (0) | 2 (0) | 18 (101) |
| trap-binary | optimised | 3448 (4) | 2 (0) | 22 (117) |
| trap-denied | optimised | 3455 (1) | 2 (0) | 23 (120) |
| trap-failure | optimised | 3451 (0) | 2 (0) | 21 (141) |
| trap-injection | optimised | 3478 (7) | 2 (0) | 25 (124) |
| trap-mutate | optimised | 3449 (4) | 2 (0) | 22 (139) |
| trap-symlink | optimised | 3450 (1) | 2 (0) | 22 (125) |
| ui-customer | optimised | 3460 (36) | 2 (0) | 20 (101) |
