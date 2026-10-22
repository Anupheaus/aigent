# Round 1: smarter `fs_search` (layers, relevance order)

**Change (library):** `fs_search` gained `layer: 'files' | 'counts'` (files with their counts, or just totals; never cut
by `maxMatches`; skip samples reduced to unreadable files) and `order: 'relevance'` (files defining the searched name
first, then by match count), plus `more: { matches, files }` when lines were left out. Its default output is
unchanged. The `optimised-r1` policy uses the files layer wherever the match lines were never needed (any-case and
whole-word searches, the noisy import/call cross, PII declarations, customer-data JSX).

**Side effect measured first:** the new schema fields add ~74 tokens to every request that offers `fs_search`, so the
committed specs were rebuilt (reference re-measured, budgets re-derived) before this round ran: the find-file
reference went from 3,294 to 3,442 tokens. Round 0's numbers stay as recorded at tag `bench-round-0`.

**Run:** `npm run bench -- --policies reference,optimised-r1 --tools round0 --repeat 3 --fresh-seeds 41 --label round-1`
(100 committed specs plus the same 100 task variants rebuilt on fresh seed 41; 3 repetitions). Results:
`round-1.json`, `round-1.summary.md`.

| solver | runs | correct | target | median tokens | p90 tokens | median turns | p90 turns |
|---|---|---|---|---|---|---|---|
| reference | 600 | 100% | 100% | 3,882 | 14,936 | 2 | 3 |
| optimised-r1 | 600 | 100% | 100% | 3,862 | 14,936 | 2 | 3 |

Targeted families (median tokens, reference → optimised-r1; IQR across seeds and wordings 21-43 tokens):
any-case 3,869 → 3,506 (-9%), noisy call 4,370 → 3,708 (-15%), whole word 3,625 → 3,437 (-5%), PII fields
3,747 → 3,469 (-7%), customer UI 3,664 → 3,492 (-5%). Every other family is unchanged (same calls). Fresh seed 41:
300/300 correct, median 3,854 (fixed seeds 3,862).

**Decision: kept.** The targeted tasks improve by 5-15%, each far beyond its IQR, and nothing regresses (correctness
100% on fixed and fresh seeds). The gain is small because a turn's fixed cost (system prompt and tool schemas, ~1,500
tokens) dominates one-search tasks; the expensive multi-step families are untouched by better search output.

Scripted policies only: what a real model gains from layers and ranking is unmeasured here.
