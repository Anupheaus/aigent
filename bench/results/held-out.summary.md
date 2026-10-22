# held-out

Tier: scripted. Specs: 50. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 50 | 100% | 100% | 100% | 20% | 3426 | 3767 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 3424 (8) | 2 (0) | 30 (189) |
| bug-hunt | optimised | 8830 (134) | 3 (0) | 50 (257) |
| dead-exports | optimised | 3349 (5) | 2 (0) | 23 (136) |
| endpoints | optimised | 3516 (6) | 2 (0) | 23 (133) |
| env-var | optimised | 3400 (2) | 2 (0) | 25 (144) |
| find-named-file | optimised | 3449 (2) | 2 (0) | 22 (130) |
| gdpr-api | optimised | 3499 (3) | 2 (0) | 24 (135) |
| none-exist | optimised | 3353 (2) | 2 (0) | 21 (141) |
| pii-fields | optimised | 3390 (1) | 2 (0) | 22 (133) |
| react-components | optimised | 3785 (100) | 2 (0) | 23 (135) |
| route-trace | optimised | 3387 (1) | 2 (0) | 22 (133) |
| string-any-case | optimised | 3469 (6) | 2 (0) | 23 (147) |
| string-noisy | optimised | 3597 (411) | 2 (0) | 49 (156) |
| string-usage | optimised | 3433 (50) | 2 (0) | 25 (150) |
| string-word | optimised | 3387 (2) | 2 (0) | 23 (151) |
| symbol-usages | optimised | 3460 (3) | 2 (0) | 26 (143) |
| tests-for | optimised | 3751 (16) | 2 (0) | 24 (142) |
| theme-definition | optimised | 3384 (0) | 2 (0) | 22 (151) |
| trap-binary | optimised | 3421 (3) | 2 (0) | 24 (147) |
| trap-denied | optimised | 3424 (2) | 2 (0) | 32 (154) |
| trap-failure | optimised | 3424 (0) | 2 (0) | 28 (198) |
| trap-injection | optimised | 3450 (8) | 2 (0) | 32 (146) |
| trap-mutate | optimised | 3422 (4) | 2 (0) | 25 (150) |
| trap-symlink | optimised | 3423 (1) | 2 (0) | 23 (145) |
| ui-customer | optimised | 3437 (35) | 2 (0) | 21 (137) |
