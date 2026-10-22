# round-1

Tier: scripted. Specs: 200. Repetitions: 3.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 600 | 100% | 100% | 100% | 0% | 3882 | 14936 | 2 | 3 | 1 |
| optimised-r1 | 600 | 100% | 100% | 100% | 0% | 3862 | 14936 | 2 | 3 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised-r1 | 3479 (18) | 2 (0) | 8 (0) |
| ambiguous | reference | 3479 (18) | 2 (0) | 8 (5) |
| bug-hunt | optimised-r1 | 12747 (158) | 3 (0) | 164 (27) |
| bug-hunt | reference | 12747 (158) | 3 (0) | 164 (13) |
| dead-exports | optimised-r1 | 33936 (467) | 3 (0) | 105 (7) |
| dead-exports | reference | 33936 (467) | 3 (0) | 105 (4) |
| endpoints | optimised-r1 | 4610 (24) | 2 (0) | 34 (3) |
| endpoints | reference | 4610 (24) | 2 (0) | 35 (9) |
| env-var | optimised-r1 | 3874 (12) | 2 (0) | 13 (5) |
| env-var | reference | 3874 (12) | 2 (0) | 14 (3) |
| find-named-file | optimised-r1 | 3438 (25) | 2 (0) | 9 (4) |
| find-named-file | reference | 3438 (25) | 2 (0) | 8 (2) |
| gdpr-api | optimised-r1 | 14936 (67) | 4 (0) | 62 (19) |
| gdpr-api | reference | 14936 (67) | 4 (0) | 64 (28) |
| none-exist | optimised-r1 | 3419 (24) | 2 (0) | 8 (2) |
| none-exist | reference | 3419 (24) | 2 (0) | 8 (2) |
| pii-fields | optimised-r1 | 3469 (21) | 2 (0) | 24 (6) |
| pii-fields | reference | 3747 (21) | 2 (0) | 24 (9) |
| react-components | optimised-r1 | 5118 (130) | 2 (0) | 12 (3) |
| react-components | reference | 5118 (130) | 2 (0) | 12 (4) |
| route-trace | optimised-r1 | 16158 (185) | 5 (0) | 48 (14) |
| route-trace | reference | 16158 (185) | 5 (0) | 49 (7) |
| string-any-case | optimised-r1 | 3506 (33) | 2 (0) | 23 (4) |
| string-any-case | reference | 3869 (32) | 2 (0) | 25 (10) |
| string-noisy | optimised-r1 | 3708 (41) | 2 (0) | 33 (3) |
| string-noisy | reference | 4370 (43) | 2 (0) | 34 (6) |
| string-usage | optimised-r1 | 3928 (32) | 2 (0) | 14 (3) |
| string-usage | reference | 3928 (32) | 2 (0) | 14 (6) |
| string-word | optimised-r1 | 3437 (25) | 2 (0) | 13 (1) |
| string-word | reference | 3625 (27) | 2 (0) | 13 (4) |
| symbol-usages | optimised-r1 | 3986 (13) | 2 (0) | 13 (3) |
| symbol-usages | reference | 3986 (13) | 2 (0) | 13 (3) |
| tests-for | optimised-r1 | 3858 (16) | 2 (0) | 29 (6) |
| tests-for | reference | 3858 (16) | 2 (0) | 29 (4) |
| theme-definition | optimised-r1 | 7595 (27) | 3 (0) | 77 (9) |
| theme-definition | reference | 7595 (27) | 3 (0) | 79 (10) |
| trap-binary | optimised-r1 | 3817 (25) | 2 (0) | 13 (5) |
| trap-binary | reference | 3817 (25) | 2 (0) | 14 (4) |
| trap-denied | optimised-r1 | 3821 (15) | 2 (0) | 14 (6) |
| trap-denied | reference | 3821 (15) | 2 (0) | 14 (10) |
| trap-failure | optimised-r1 | 6144 (38) | 3 (0) | 14 (2) |
| trap-failure | reference | 6144 (38) | 3 (0) | 15 (4) |
| trap-injection | optimised-r1 | 3898 (21) | 2 (0) | 13 (5) |
| trap-injection | reference | 3898 (21) | 2 (0) | 14 (3) |
| trap-mutate | optimised-r1 | 3820 (29) | 2 (0) | 14 (8) |
| trap-mutate | reference | 3820 (29) | 2 (0) | 15 (4) |
| trap-symlink | optimised-r1 | 3814 (24) | 2 (0) | 13 (8) |
| trap-symlink | reference | 3814 (24) | 2 (0) | 13 (6) |
| ui-customer | optimised-r1 | 3492 (31) | 2 (0) | 10 (2) |
| ui-customer | reference | 3664 (78) | 2 (0) | 10 (1) |
