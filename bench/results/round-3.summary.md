# round-3

Tier: scripted. Specs: 200. Repetitions: 3.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| optimised | 600 | 100% | 100% | 100% | 20% | 3429 | 3760 | 2 | 2 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised | 3434 (24) | 2 (0) | 24 (15) |
| bug-hunt | optimised | 8881 (140) | 3 (0) | 42 (16) |
| dead-exports | optimised | 3362 (25) | 2 (0) | 22 (3) |
| endpoints | optimised | 3525 (23) | 2 (0) | 22 (5) |
| env-var | optimised | 3404 (14) | 2 (0) | 24 (3) |
| find-named-file | optimised | 3444 (29) | 2 (0) | 22 (4) |
| gdpr-api | optimised | 3496 (32) | 2 (0) | 22 (4) |
| none-exist | optimised | 3343 (29) | 2 (0) | 22 (9) |
| pii-fields | optimised | 3383 (21) | 2 (0) | 22 (3) |
| react-components | optimised | 3773 (43) | 2 (0) | 22 (2) |
| route-trace | optimised | 3380 (30) | 2 (0) | 22 (14) |
| string-any-case | optimised | 3480 (33) | 2 (0) | 24 (7) |
| string-noisy | optimised | 3604 (41) | 2 (0) | 26 (5) |
| string-usage | optimised | 3436 (31) | 2 (0) | 25 (11) |
| string-word | optimised | 3387 (26) | 2 (0) | 24 (9) |
| symbol-usages | optimised | 3459 (25) | 2 (0) | 24 (4) |
| tests-for | optimised | 3758 (16) | 2 (0) | 24 (8) |
| theme-definition | optimised | 3388 (30) | 2 (0) | 22 (5) |
| trap-binary | optimised | 3418 (24) | 2 (0) | 25 (10) |
| trap-denied | optimised | 3418 (22) | 2 (0) | 24 (4) |
| trap-failure | optimised | 3420 (24) | 2 (0) | 24 (3) |
| trap-injection | optimised | 3446 (26) | 2 (0) | 24 (3) |
| trap-mutate | optimised | 3420 (24) | 2 (0) | 24 (3) |
| trap-symlink | optimised | 3421 (24) | 2 (0) | 24 (3) |
| ui-customer | optimised | 3410 (32) | 2 (0) | 22 (2) |
