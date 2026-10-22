# Held-out run

## The run that counts (after the slice-15 review fixes)

The review found that the prompt reader had been fitted to the first held-out wording (two cues only held-out prompts
used, and a test forcing the reader to understand every held-out prompt), so that run was not evidence of
generalisation. The cues were removed, the test now checks the reader on tuning wordings only, and a **new held-out
wording** for all 25 tasks was written before the re-measured results were seen and before any held-out run. Its author
knew the reader's cues; the wordings were written as a user would ask and were not checked against the reader. It was
run **once**, on seeds 1000 (small) and 1001 (medium), after every other change:

```
npm run bench -- --build-specs --held-out          # held-out specs; measures their reference
npm run bench -- --held-out --policies reference --tools round0 --label held-out-reference
npm run bench -- --held-out --policies optimised --tools optimised --label held-out
npm run bench -- --held-out --policies optimised --tools index --label held-out-tools-only   # control
```

| solver | tool set | runs | correct | median tokens* | p90 tokens* | median turns* | p90 turns* |
|---|---|---|---|---|---|---|---|
| reference | round0 | 50 | **68%** (34/50) | 3,850 | 7,600 | 2 | 3 |
| optimised (Round 3) | optimised | 50 | **68%** (34/50) | 3,453 | 3,799 | 2 | 2 |
| optimised, tools-only control | index | 50 | 68% (34/50) | 4,575 | 4,921 | 2 | 2 |

\* over the correct runs only (the same 34 specs for every solver).

**The reader does not generalise.** On 8 of the 25 tasks the scripted prompt reader misread the new wording, so every
policy that uses it (the reference and the optimised one alike) answered the wrong question on both seeds:

| task | held-out wording (abridged) | what went wrong |
|---|---|---|
| bug-hunt | "point out anything that is actually broken" | not understood ("bug", "defect" are the cues) |
| dead-exports | "exported functions that no other file imports or uses" | not understood ("unused", "never used", "dead export"...) |
| endpoints | "What routes does our HTTP server expose?" | not understood ("routes" is not a cue) |
| gdpr-api | "handlers for data-protection requests" | not understood ("GDPR" is the only cue) |
| pii-fields | "personal information fields" | not understood (cues are "PII" and "personal data") |
| string-any-case | "regardless of how it is written (snake_case...)" | read as a code-usage search: recall 0.14 |
| string-word | "as a standalone, case-matching word" | read as a code-usage search: recall 0.25 |
| symbol-usages | "Where does `x` come from, and which files use it?" | read as non-test usage: misses the tests, recall 0.80 |

A prompt that is not understood makes the policies answer that they could not work out the question, which the checker
fails.

The previously reported held-out run (100% correct for both, "the prompt reader understood every held-out wording")
measured a reader fitted to that wording; this run is the honest figure. Real models read prompts very differently, so
this says nothing about them; it does say the scripted tier's correctness is a property of the wordings it was tuned on.

**Where both are correct**, the gains carry over at the same size as on the tuned set: median tokens -10.3% (3,850 →
3,453; tuned set -11.2%), and with every tool offered (the control) the optimised policy is 18.8% dearer than the
reference at the median, as on the tuned set (+17.7%): the median saving is the smaller tool set. The p90 comparison
(-50%) is not comparable with the tuned set's -74.6%, because three of the most expensive families (bug hunt, dead
exports, GDPR) are among the misread tasks.

**One wording replaced after the run (disclosed).** The committed hint linter rejected the PII held-out wording
("types or schemas"): "schemas" is a directory on an answer path of seed 1001, so the prompt leaked a hint. The drafts
should have been linted before the run. The policies were **not** run again: the reported results are those of the one
run, where the reader misread that prompt in any case (no hint was used). The committed spec now carries a neutral
wording ("Which data shapes include personal information fields...?"); building it measured the reference on it, which
misread it too ("expected a list of files"). The optimised policy has not been run on it.

Budgets of held-out specs whose reference was wrong are derived from that wrong run (the spec records the reference's
`failures`), so their tiers mean nothing; only correctness and the correct runs' costs are reported above.

Scripted tier only; real-model behaviour on the held-out set is unmeasured.

## The first held-out run (superseded)

Run once after Round 3 on the first held-out wording, with the reader fitted to it (see above): reference 100% correct,
median 3,871, p90 14,890; optimised 100% correct, median 3,426, p90 3,767 (-11.5% / -74.7%). Not evidence of
generalisation; kept only as the record of what was first reported.
