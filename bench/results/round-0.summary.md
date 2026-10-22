# round-0

Tier: scripted. Specs: 100. Repetitions: 3.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 300 | 100% | 100% | 100% | 0% | 3737 | 14640 | 2 | 3 | 1 |
| naive | 300 | 100% | 99% | 0% | 0% | 10298 | 24945 | 4 | 6 | 3 |

## Per task family

| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |
|---|---|---|---|---|
| ambiguous | naive | 8387 (46) | 4 (0) | 13 (8) |
| ambiguous | reference | 3336 (25) | 2 (0) | 10 (24) |
| bug-hunt | naive | 22856 (127) | 6 (0) | 160 (19) |
| bug-hunt | reference | 12461 (85) | 3 (0) | 157 (42) |
| dead-exports | naive | 65106 (577) | 4 (0) | 1381 (67) |
| dead-exports | reference | 33407 (197) | 3 (0) | 115 (5) |
| endpoints | naive | 10945 (41) | 4 (0) | 39 (11) |
| endpoints | reference | 4462 (19) | 2 (0) | 37 (5) |
| env-var | naive | 9301 (34) | 4 (0) | 17 (10) |
| env-var | reference | 3728 (15) | 2 (0) | 13 (2) |
| find-named-file | naive | 9035 (101) | 4 (0) | 11 (6) |
| find-named-file | reference | 3291 (28) | 2 (0) | 8 (1) |
| gdpr-api | naive | 30293 (40) | 7 (0) | 74 (16) |
| gdpr-api | reference | 14640 (23) | 4 (0) | 60 (19) |
| none-exist | naive | 8369 (72) | 4 (0) | 11 (6) |
| none-exist | reference | 3265 (28) | 2 (0) | 9 (3) |
| pii-fields | naive | 10830 (183) | 4 (0) | 28 (9) |
| pii-fields | reference | 3599 (21) | 2 (0) | 22 (2) |
| react-components | naive | 10970 (174) | 4 (0) | 12 (3) |
| react-components | reference | 4879 (89) | 2 (0) | 12 (2) |
| route-trace | naive | 24925 (57) | 7 (0) | 60 (30) |
| route-trace | reference | 15886 (41) | 5 (0) | 50 (13) |
| string-any-case | naive | 10298 (82) | 4 (0) | 39 (10) |
| string-any-case | reference | 3721 (33) | 2 (0) | 23 (13) |
| string-noisy | naive | 9896 (99) | 4 (0) | 18 (10) |
| string-noisy | reference | 4222 (42) | 2 (0) | 36 (10) |
| string-usage | naive | 10341 (72) | 4 (0) | 16 (1) |
| string-usage | reference | 3778 (32) | 2 (0) | 13 (3) |
| string-word | naive | 8939 (59) | 4 (0) | 16 (4) |
| string-word | reference | 3467 (22) | 2 (0) | 13 (2) |
| symbol-usages | naive | 11363 (71) | 4 (0) | 20 (5) |
| symbol-usages | reference | 3836 (9) | 2 (0) | 13 (3) |
| tests-for | naive | 10315 (103) | 4 (0) | 41 (11) |
| tests-for | reference | 3710 (16) | 2 (0) | 35 (12) |
| theme-definition | naive | 23437 (46) | 6 (0) | 92 (15) |
| theme-definition | reference | 7373 (26) | 3 (0) | 77 (21) |
| trap-binary | naive | 9359 (31) | 4 (0) | 16 (2) |
| trap-binary | reference | 3669 (14) | 2 (0) | 12 (1) |
| trap-denied | naive | 9376 (17) | 4 (0) | 16 (1) |
| trap-denied | reference | 3674 (18) | 2 (0) | 13 (3) |
| trap-failure | naive | 9226 (41) | 4 (0) | 16 (5) |
| trap-failure | reference | 5911 (30) | 3 (0) | 14 (8) |
| trap-injection | naive | 11224 (64) | 4 (0) | 17 (3) |
| trap-injection | reference | 3746 (31) | 2 (0) | 13 (4) |
| trap-mutate | naive | 9388 (102) | 4 (0) | 16 (2) |
| trap-mutate | reference | 3673 (38) | 2 (0) | 13 (2) |
| trap-symlink | naive | 9344 (65) | 4 (0) | 17 (4) |
| trap-symlink | reference | 3666 (25) | 2 (0) | 13 (6) |
| ui-customer | naive | 9268 (207) | 4 (0) | 12 (10) |
| ui-customer | reference | 3488 (38) | 2 (0) | 10 (5) |
