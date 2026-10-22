# round-0

Tier: scripted. Specs: 100. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 100 | 100% | 100% | 100% | 0% | 3885 | 14936 | 2 | 3 | 1 |
| naive | 100 | 100% | 99% | 0% | 0% | 10594 | 25463 | 4 | 6 | 3 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | naive | 8683 (46) | 4 (0) | 14 (8) |
| ambiguous | reference | 3484 (25) | 2 (0) | 13 (23) |
| bug-hunt | naive | 23300 (127) | 6 (0) | 137 (18) |
| bug-hunt | reference | 12683 (85) | 3 (0) | 131 (56) |
| dead-exports | naive | 65521 (576) | 4 (0) | 1685 (318) |
| dead-exports | reference | 33629 (197) | 3 (0) | 135 (28) |
| endpoints | naive | 11241 (41) | 4 (0) | 45 (27) |
| endpoints | reference | 4610 (19) | 2 (0) | 45 (15) |
| env-var | naive | 9597 (34) | 4 (0) | 17 (2) |
| env-var | reference | 3876 (15) | 2 (0) | 13 (3) |
| find-named-file | naive | 9331 (101) | 4 (0) | 11 (1) |
| find-named-file | reference | 3439 (28) | 2 (0) | 9 (6) |
| gdpr-api | naive | 30811 (40) | 7 (0) | 79 (5) |
| gdpr-api | reference | 14936 (23) | 4 (0) | 67 (17) |
| none-exist | naive | 8665 (72) | 4 (0) | 13 (2) |
| none-exist | reference | 3413 (28) | 2 (0) | 9 (3) |
| pii-fields | naive | 11126 (183) | 4 (0) | 28 (2) |
| pii-fields | reference | 3747 (21) | 2 (0) | 23 (2) |
| react-components | naive | 11266 (174) | 4 (0) | 13 (1) |
| react-components | reference | 5027 (89) | 2 (0) | 12 (3) |
| route-trace | naive | 25443 (57) | 7 (0) | 54 (9) |
| route-trace | reference | 16256 (41) | 5 (0) | 65 (21) |
| string-any-case | naive | 10594 (82) | 4 (0) | 38 (2) |
| string-any-case | reference | 3869 (33) | 2 (0) | 22 (1) |
| string-noisy | naive | 10192 (99) | 4 (0) | 16 (1) |
| string-noisy | reference | 4370 (42) | 2 (0) | 34 (6) |
| string-usage | naive | 10637 (72) | 4 (0) | 17 (6) |
| string-usage | reference | 3926 (32) | 2 (0) | 13 (0) |
| string-word | naive | 9235 (59) | 4 (0) | 15 (6) |
| string-word | reference | 3615 (22) | 2 (0) | 14 (2) |
| symbol-usages | naive | 11659 (71) | 4 (0) | 17 (1) |
| symbol-usages | reference | 3984 (9) | 2 (0) | 13 (2) |
| tests-for | naive | 10611 (103) | 4 (0) | 42 (9) |
| tests-for | reference | 3858 (16) | 2 (0) | 34 (3) |
| theme-definition | naive | 23881 (46) | 6 (0) | 89 (3) |
| theme-definition | reference | 7595 (26) | 3 (0) | 77 (6) |
| trap-binary | naive | 9655 (31) | 4 (0) | 18 (2) |
| trap-binary | reference | 3817 (14) | 2 (0) | 13 (3) |
| trap-denied | naive | 9672 (17) | 4 (0) | 16 (1) |
| trap-denied | reference | 3822 (18) | 2 (0) | 14 (1) |
| trap-failure | naive | 9522 (41) | 4 (0) | 17 (4) |
| trap-failure | reference | 6133 (30) | 3 (0) | 14 (1) |
| trap-injection | naive | 11520 (64) | 4 (0) | 16 (1) |
| trap-injection | reference | 3894 (31) | 2 (0) | 14 (5) |
| trap-mutate | naive | 9684 (102) | 4 (0) | 16 (4) |
| trap-mutate | reference | 3821 (38) | 2 (0) | 13 (1) |
| trap-symlink | naive | 9640 (65) | 4 (0) | 15 (4) |
| trap-symlink | reference | 3814 (25) | 2 (0) | 13 (0) |
| ui-customer | naive | 9564 (207) | 4 (0) | 12 (1) |
| ui-customer | reference | 3636 (38) | 2 (0) | 11 (3) |
