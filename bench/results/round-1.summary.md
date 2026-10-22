# round-1

Tier: scripted. Specs: 200. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 200 | 100% | 100% | 100% | 0% | 3882 | 14936 | 2 | 3 | 1 |
| optimised-r1 | 200 | 100% | 100% | 100% | 0% | 3862 | 14936 | 2 | 3 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | optimised-r1 | 3479 (18) | 2 (0) | 9 (2) |
| ambiguous | reference | 3479 (18) | 2 (0) | 12 (5) |
| bug-hunt | optimised-r1 | 12747 (158) | 3 (0) | 175 (27) |
| bug-hunt | reference | 12747 (158) | 3 (0) | 163 (18) |
| dead-exports | optimised-r1 | 33936 (467) | 3 (0) | 101 (9) |
| dead-exports | reference | 33936 (467) | 3 (0) | 103 (2) |
| endpoints | optimised-r1 | 4610 (24) | 2 (0) | 34 (7) |
| endpoints | reference | 4610 (24) | 2 (0) | 35 (15) |
| env-var | optimised-r1 | 3874 (12) | 2 (0) | 13 (1) |
| env-var | reference | 3874 (12) | 2 (0) | 13 (4) |
| find-named-file | optimised-r1 | 3438 (25) | 2 (0) | 8 (1) |
| find-named-file | reference | 3438 (25) | 2 (0) | 9 (3) |
| gdpr-api | optimised-r1 | 14936 (67) | 4 (0) | 65 (15) |
| gdpr-api | reference | 14936 (67) | 4 (0) | 61 (13) |
| none-exist | optimised-r1 | 3419 (24) | 2 (0) | 9 (6) |
| none-exist | reference | 3419 (24) | 2 (0) | 9 (5) |
| pii-fields | optimised-r1 | 3469 (21) | 2 (0) | 24 (2) |
| pii-fields | reference | 3747 (21) | 2 (0) | 22 (3) |
| react-components | optimised-r1 | 5118 (130) | 2 (0) | 11 (2) |
| react-components | reference | 5118 (130) | 2 (0) | 12 (3) |
| route-trace | optimised-r1 | 16158 (185) | 5 (0) | 49 (16) |
| route-trace | reference | 16158 (185) | 5 (0) | 53 (24) |
| string-any-case | optimised-r1 | 3506 (33) | 2 (0) | 23 (2) |
| string-any-case | reference | 3869 (32) | 2 (0) | 24 (4) |
| string-noisy | optimised-r1 | 3708 (41) | 2 (0) | 33 (1) |
| string-noisy | reference | 4370 (43) | 2 (0) | 33 (8) |
| string-usage | optimised-r1 | 3928 (32) | 2 (0) | 13 (2) |
| string-usage | reference | 3928 (32) | 2 (0) | 13 (3) |
| string-word | optimised-r1 | 3437 (25) | 2 (0) | 13 (1) |
| string-word | reference | 3625 (27) | 2 (0) | 14 (3) |
| symbol-usages | optimised-r1 | 3986 (13) | 2 (0) | 15 (4) |
| symbol-usages | reference | 3986 (13) | 2 (0) | 15 (4) |
| tests-for | optimised-r1 | 3858 (16) | 2 (0) | 29 (3) |
| tests-for | reference | 3858 (16) | 2 (0) | 29 (1) |
| theme-definition | optimised-r1 | 7595 (27) | 3 (0) | 77 (15) |
| theme-definition | reference | 7595 (27) | 3 (0) | 78 (22) |
| trap-binary | optimised-r1 | 3817 (25) | 2 (0) | 13 (4) |
| trap-binary | reference | 3817 (25) | 2 (0) | 13 (1) |
| trap-denied | optimised-r1 | 3821 (15) | 2 (0) | 13 (5) |
| trap-denied | reference | 3821 (15) | 2 (0) | 15 (5) |
| trap-failure | optimised-r1 | 6144 (38) | 3 (0) | 15 (7) |
| trap-failure | reference | 6144 (38) | 3 (0) | 16 (13) |
| trap-injection | optimised-r1 | 3898 (21) | 2 (0) | 13 (0) |
| trap-injection | reference | 3898 (21) | 2 (0) | 13 (1) |
| trap-mutate | optimised-r1 | 3820 (29) | 2 (0) | 14 (5) |
| trap-mutate | reference | 3820 (29) | 2 (0) | 15 (4) |
| trap-symlink | optimised-r1 | 3814 (24) | 2 (0) | 13 (2) |
| trap-symlink | reference | 3814 (24) | 2 (0) | 14 (2) |
| ui-customer | optimised-r1 | 3492 (31) | 2 (0) | 10 (1) |
| ui-customer | reference | 3664 (78) | 2 (0) | 10 (0) |
