# Round 3: layered answers everywhere, a trimmed tool set, re-tune

**Change:** the `optimised` policy answers every search question with `search_layers` at the files layer (identifier
usages with `where: 'code'` and test, story and mock files excluded by tag; any-case, whole-word and the noisy
import/call cross), finds files by name with `repo_find`, finds a module's tests in one turn (`repo_find` by name plus
`search_layers` snippets of imports ending in its stem, resolved), and runs the bug review's risk searches at the files
layer before one batched read. With every search going through the index, the tool set **`optimised`** keeps only
`fs_read` beside the index tools: `fs_search` and `fs_list` are no longer offered.

**Batching guidance in tool descriptions / system rules:** measured, not adopted. The descriptions already say "answer at
the cheapest layer" and "batch related searches" in one line each; a longer rule in the system prompt (a tool
`promptAddendum`) would add its tokens to every request, and the scripted tier cannot measure any benefit (scripted
policies do not read prompts). Left for the model tier.

## Re-measured after the review fixes

The slice-15 review found defects in the index and the checker (cards reused across paths, name-based route liveness
and dead exports, silently dropped unreadable files and a hidden second walk per cached call, a lenient none-exist
check). After the fixes every round was run again on the current code:

```
npm run bench -- --policies optimised --tools optimised --fresh-seeds 43 --label round-3
npm run bench -- --policies optimised --tools index --fresh-seeds 43 --label round-3-tools-only   # control
```

One repetition: the scripted tier is deterministic (tokens, turns and calls are identical between repetitions; the self-
tests check the reference reproduces its committed measurement), so the earlier three repetitions only tripled the rows.

| solver | tool set | runs | correct | target | stretch | median tokens | p90 tokens | median turns | p90 turns |
|---|---|---|---|---|---|---|---|---|---|
| reference (Round 1 run) | round0 | 200 | 100% | 100% | 0% | 3,882 | 14,936 | 2 | 3 |
| optimised-r2 | index | 200 | 100% | 100% | 16% | 4,844 | 5,151 | 2 | 2 |
| optimised, **tools-only control** | index | 200 | 100% | 100% | 20% | 4,569 | 4,912 | 2 | 2 |
| optimised (Round 3) | optimised | 200 | 100% | 100% | 20% | 3,447 | 3,790 | 2 | 2 |

Previously reported for Round 3: median 3,429, p90 3,760. The re-measured run is 18 tokens dearer at the median (30 at
p90): every index tool result now carries `skipped` (and `unreadable` when a file could not be read), which the review
asked for. The bug hunt grew most (about 8,890 → 9,230), since it sends one `search_layers` item per risk pattern and each
item reports the skips. Correctness stays 100% on fixed and fresh seeds.

**The control (M5).** The control plays the same Round 3 policy but offers the Round 2 tool set (`fs_read`,
`fs_search` and the index tools), so the only difference to the Round 3 row is the schemas sent with every request.

- **Median tokens: the gain is entirely the trimmed tool set.** With every tool offered, the Round 3 policy costs 4,569
  at the median, 17.7% *more* than the reference (3,882): the index schemas ride on every request. Removing
  `fs_search` saves about 560 tokens per request (1,122 per two-turn run) and takes it to 3,447. Against Round 2
  (4,844) the policy and tool-use changes alone save 5.7%.
- **p90 tokens and turns: the gain is the index.** Even with every schema offered, p90 tokens fall from 14,936 to 4,912
  (-67%) and p90 turns from 3 to 2, because the multi-step families (dead exports, route trace, GDPR, theme, bug hunt)
  are answered in one or two turns from the index.

**Against the reference** (re-measured on the current tools): median tokens -11.2% (3,882 → 3,447; previously
reported -11.7%), p90 tokens -74.6% (14,936 → 3,790; previously -74.8%), p90 turns 3 → 2, median turns 2 → 2.

Per family (median tokens, reference → Round 3; the tools-only control in brackets): dead exports -90% (-87%), route
trace -79% (-72%), GDPR -77% (-69%), theme -55% (-40%), trap failure -44% (-26%), bug hunt -28% (-14%), React -26%
(-4%), endpoints -23% (+1%), noisy call -17% (+9%), symbol/usage/env/injection -11% to -13% (+15% to +18%),
mutate/binary/denied/symlink/any-case -10% (+19% to +20%), PII -9% (+21%), customer UI -6% (+24%), word -6% (+25%),
none-exist -2% (+31%), tests-for -2% (+27%), ambiguous -1% (+31%), find-file +0.7% (+33%). Find-file is now 23 tokens
dearer than the reference (the skip report); no other family is. Every one-search family is dearer than the reference
in the control: on those, Round 3 wins only by sending fewer schemas.

**Trap failure.** Its -44% comes from a deliberate design choice, not from tool use: the index retries a failed read
once inside the same call (`readWithRetry`), so the injected one-off failure costs nothing, while `fs_search` reports
the file as unreadable and the reference spends a turn searching it again. Previously the same saving came from an
accidental second walk per cached call (now removed). `fs_search` could adopt the same retry; until then this family
compares a retrying tool with a non-retrying one.

**What "beyond its IQR" meant (M4).** Earlier write-ups called gains significant because they exceeded the IQR. The
scripted tier has no run-to-run noise at all, so that is not a noise test: the IQRs in `round-3.summary.md` are the
spread across wordings and seeds within a family. A gain larger than that spread is consistent across wordings and
seeds, nothing more.

**Fitted to the generator (M7).** The strategies of both the expert reference and the optimised policy hard-code the
generator's conventions: the `ApiRequest` handler type, `createTheme(` and `*Tokens` theme constants, the personal-data
field list, the `analytics` import path, `createRouter()`. Their correctness and costs therefore show what the tools make
possible on repositories written in those conventions, not how either strategy would do on other code.

**Decision: kept, and Round 2 with it**, with the attribution corrected: the median saving is the smaller tool set made
possible by the index; the tail (p90) saving is the index itself.

**Budgets:** `bench/budgets.json` is re-derived from the committed suite on the re-measured code (each spec's best run
+ 15%; turns and tool calls only by whole steps, so p90 turns ≤ 2 instead of 3; median tokens ≤ 3,963; pass rate 100%)
and enforced in CI by `npm run bench -- --policies optimised --tools optimised --gate`, which now also fails when a
budgeted spec did not run or a spec has no budget.

**Honesty:** these are scripted policies playing the model with ideal judgement; they show what the tools make
possible, not what a real model will do with them. Real-model gains (Ollama, DeepSeek, Claude) are unmeasured: no model
was run in this environment.
