# round-3

Tier: scripted. Specs: 200. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 200 | 100% | 100% | 100% | 20% | 3447 | 3790 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 3451 (24) | 2 (0) | 21 (16) |
| bug-hunt | optimised | 9227 (139) | 3 (0) | 61 (18) |
| dead-exports | optimised | 3379 (25) | 2 (0) | 19 (3) |
| endpoints | optimised | 3543 (23) | 2 (0) | 20 (1) |
| env-var | optimised | 3422 (15) | 2 (0) | 22 (2) |
| find-named-file | optimised | 3461 (29) | 2 (0) | 18 (0) |
| gdpr-api | optimised | 3513 (32) | 2 (0) | 21 (10) |
| none-exist | optimised | 3360 (29) | 2 (0) | 18 (3) |
| pii-fields | optimised | 3400 (22) | 2 (0) | 18 (3) |
| react-components | optimised | 3790 (42) | 2 (0) | 20 (4) |
| route-trace | optimised | 3406 (30) | 2 (0) | 18 (4) |
| string-any-case | optimised | 3497 (33) | 2 (0) | 25 (4) |
| string-noisy | optimised | 3638 (40) | 2 (0) | 36 (18) |
| string-usage | optimised | 3453 (32) | 2 (0) | 29 (13) |
| string-word | optimised | 3404 (26) | 2 (0) | 22 (1) |
| symbol-usages | optimised | 3476 (26) | 2 (0) | 22 (1) |
| tests-for | optimised | 3793 (17) | 2 (0) | 20 (4) |
| theme-definition | optimised | 3406 (30) | 2 (0) | 18 (1) |
| trap-binary | optimised | 3435 (25) | 2 (0) | 24 (12) |
| trap-denied | optimised | 3439 (22) | 2 (0) | 23 (2) |
| trap-failure | optimised | 3437 (25) | 2 (0) | 23 (3) |
| trap-injection | optimised | 3464 (27) | 2 (0) | 22 (2) |
| trap-mutate | optimised | 3437 (24) | 2 (0) | 23 (3) |
| trap-symlink | optimised | 3438 (25) | 2 (0) | 22 (2) |
| ui-customer | optimised | 3428 (31) | 2 (0) | 23 (10) |
