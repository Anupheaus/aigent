# held-out-reference

Tier: scripted. Specs: 50. Repetitions: 1.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 50 | 100% | 100% | 100% | 0% | 3871 | 14890 | 2 | 3 | 1 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | reference | 3485 (4) | 2 (0) | 13 (75) |
| bug-hunt | reference | 12710 (131) | 3 (0) | 149 (925) |
| dead-exports | reference | 33898 (503876) | 3 (6) | 106 (3448) |
| endpoints | reference | 4599 (1) | 2 (0) | 38 (213) |
| env-var | reference | 3868 (14) | 2 (0) | 15 (77) |
| find-named-file | reference | 3439 (2) | 2 (0) | 8 (51) |
| gdpr-api | reference | 14890 (51) | 4 (0) | 62 (355) |
| none-exist | reference | 3420 (2) | 2 (0) | 11 (49) |
| pii-fields | reference | 3757 (0) | 2 (0) | 26 (134) |
| react-components | reference | 5044 (248) | 2 (0) | 12 (67) |
| route-trace | reference | 16204 (46) | 5 (0) | 50 (334) |
| string-any-case | reference | 3863 (8) | 2 (0) | 26 (126) |
| string-noisy | reference | 4357 (1830) | 2 (0) | 40 (207) |
| string-usage | reference | 3928 (121) | 2 (0) | 13 (79) |
| string-word | reference | 3626 (3) | 2 (0) | 14 (74) |
| symbol-usages | reference | 3991 (2) | 2 (0) | 17 (87) |
| tests-for | reference | 3853 (12) | 2 (0) | 34 (188) |
| theme-definition | reference | 7579 (4) | 3 (0) | 78 (521) |
| trap-binary | reference | 3816 (0) | 2 (0) | 16 (77) |
| trap-denied | reference | 3829 (1) | 2 (0) | 13 (81) |
| trap-failure | reference | 6151 (5) | 3 (0) | 14 (95) |
| trap-injection | reference | 3901 (13) | 2 (0) | 14 (75) |
| trap-mutate | reference | 3815 (12) | 2 (0) | 13 (78) |
| trap-symlink | reference | 3818 (6) | 2 (0) | 14 (77) |
| ui-customer | reference | 3669 (42) | 2 (0) | 13 (51) |
