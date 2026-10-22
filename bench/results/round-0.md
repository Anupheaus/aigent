# Round 0: baseline (scripted tier, Round-0 tools)

Run (as first recorded, at tag `bench-round-0`): `npm run bench -- --tier scripted --repeat 3 --policies reference,naive --label round-0` on the 100 committed,
non-held-out specs (25 tasks x 4 wordings; seeds 1, 2, 3; small, medium and large repositories). Tools: `fs_list`,
`fs_read`, `fs_search` from the existing filesystem pack, no index. Raw rows: `round-0.json`; generated table:
`round-0.summary.md`.

**What this measures.** Two scripted policies play the model through the real agent loop and tools: `reference` (the
expert path: targeted searches with the default ignores, batched reads) and `naive` (orients itself by listing, searches
without ignores or exactness, reads every candidate). Tokens are the bench's fixed `ceil(chars / 4)` estimate of every
request as sent plus every response. No real model was run; real-model behaviour is unmeasured.

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 300 | 100% | 100% | 100% | 0% | 3737 | 14640 | 2 | 3 | 1 |
| naive | 300 | 100% | 99% | 0% | 0% | 10298 | 24945 | 4 | 6 | 3 |

**Re-measured after the slice-15 review fixes** (`npm run bench -- --policies reference,naive --tools round0 --label
round-0`, one repetition; `round-0.json` and `round-0.summary.md` now hold this run). The Round-0 tools no longer exist
as they were: `fs_search` gained its layer and order fields in Round 1, which every request carries, so this is the
reference on the current tools (the same figures as the reference of the Round 1 run):

| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 100 | 100% | 100% | 100% | 0% | 3,885 | 14,936 | 2 | 3 | 1 |
| naive | 100 | 100% | 99% | 0% | 0% | 10,594 | 25,463 | 4 | 6 | 3 |

The review fixes do not touch the Round-0 tools, so correctness is unchanged; the stricter none-exist check (a text
answer is no longer read as "none") changed no verdict here.

Variance: the scripted policies are deterministic, so tokens, turns and calls do not vary between repetitions (hence
one repetition from now on); the IQRs in `round-0.summary.md` are across wordings and seeds (at most 1-2% of a family's
median, from prompt length and the generated names), not noise. Wall time varies by tens of milliseconds and is far
inside every budget.

## What the numbers say

- **The fixed cost of a turn dominates.** Every request re-sends the system prompt and the three tool schemas (about
  1,500 tokens) plus the conversation so far. A one-search task costs ~3,300-3,800 tokens, of which the search result is
  ~150. The naive policy's extra cost is mostly its two extra turns (orientation listing, then reading candidates), not
  the size of what it reads: 2.3-3x the reference on most families.
- **Expensive families are multi-step ones** where Round-0 tools force a chain of dependent turns: dead exports
  (33k tokens: one search for every export, then alternation searches over ~100 names), route tracing (16k, 5 turns:
  registration, router, handler, data module), GDPR handlers (14.6k, 4 turns: learn the privacy operations by reading,
  then cross callers with handlers), bug hunt (12.5k, one wide read of every suspicious file) and theme (7.4k, 3 turns:
  definitions, then a reference check per definition).
- **Noisy searches** cost the naive policy most on large repositories: `string-noisy` on the 8,000-file repository is
  the one spec where naive exceeds the pass budget (it reads ~120 files that merely contain the word).
- **Repository size barely moves the reference** because `fs_search` already skips build output, lockfiles and minified
  files: medium and large runs cost within 5% of small ones, except `string-noisy` (large: 11.6k) and dead exports.

## Biggest inefficiencies (candidates for the rounds)

1. Tokens spent re-sending context across dependent turns in multi-step tasks (route trace, GDPR, theme, dead exports):
   needs tools that answer the structural question directly (an index with symbols, imports and tags).
2. Classification by searching and then reading (theme, React, GDPR, PII): needs file classification tags.
3. Verbose search results (per-file match lists with full lines and skip samples) when only the file list or a count
   was needed: needs counts-first and layered answers.
4. Repeated reads to confirm what a structural index could state (router → handler → data module).
