# Round 3: layered answers everywhere, a trimmed tool set, re-tune

**Change:** the `optimised` policy answers every search question with `search_layers` at the files layer (identifier
usages with `where: 'code'` and test, story and mock files excluded by tag; any-case, whole-word and the noisy
import/call cross), finds files by name with `repo_find`, finds a module's tests in one turn (`repo_find` by name plus
`search_layers` snippets of imports ending in its stem, resolved), and runs the bug review's risk searches at the files
layer before one batched read. With every search going through the index, the tool set **`optimised`** keeps only
`fs_read` beside the index tools: `fs_search` and `fs_list` are no longer offered, which removes their ~880 tokens of
schema from every request.

**Batching guidance in tool descriptions / system rules:** measured, not adopted. The descriptions already say "answer at
the cheapest layer" and "batch related searches" in one line each; a longer rule in the system prompt (a tool
`promptAddendum`) would add its tokens to every request, and the scripted tier cannot measure any benefit (scripted
policies do not read prompts). Left for the model tier.

**Run:** `npm run bench -- --policies optimised --tools optimised --repeat 3 --fresh-seeds 43 --label round-3`.

| solver | runs | correct | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|
| reference (Round 1 run) | 600 | 100% | 100% | 0% | 3,882 | 14,936 | 2 | 3 | 1 |
| optimised-r2 | 600 | 100% | 100% | 16% | 4,844 | 5,151 | 2 | 2 | 1 |
| optimised (Round 3) | 600 | 100% | 100% | 20% | 3,429 | 3,760 | 2 | 2 | 1 |

Per family (median tokens, reference → Round 3): dead exports -90%, route trace -79%, GDPR -77%, theme -55%, trap
failure -44% (no retry turn: the index re-reads a file whose first read failed), bug hunt -30%, React -26%, endpoints
-24%, noisy call -18%, symbol/usage/env/injection -12% to -13%, any-case/binary/denied/mutate/symlink -10% to -11%,
PII -10%, word -7%, customer UI -7%, tests-for -3%, none-exist -2%, ambiguous -1%, find-file 0%. No family is dearer
than the reference; IQRs stay at 14-43 tokens. Fresh seed 43: 300/300 correct, median 3,429 (fixed seeds 3,428).

**Decision: kept, and Round 2 with it.** Against the Round-0 reference (re-measured on the current tools): median tokens
-11.7% (3,882 → 3,429), p90 tokens -74.8% (14,936 → 3,760), p90 turns 3 → 2, median turns 2 → 2, correctness 100% on
fixed and fresh seeds, every spec at target or better (20% at stretch). The Round 2 regression is gone.

**Budgets:** `bench/budgets.json` is tightened to this round (each spec's best run + 15%, median tokens ≤ 3,943, p90
turns ≤ 3, pass rate 100%) and enforced in CI by `npm run bench -- --policies optimised --tools optimised --gate`.

**Honesty:** these are scripted policies playing the model with ideal judgement; they show what the tools make
possible, not what a real model will do with them. Real-model gains (Ollama, DeepSeek, Claude) are unmeasured: no model
was run in this environment.
