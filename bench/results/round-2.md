# Round 2: repository index and classification tags

**Change (library):** the new `@anupheaus/aigent/tools/index` pack: an incremental index of the root (cards per file:
exports, functions, symbols, resolved imports, identifiers used in code, route registrations, mounts) with
deterministic tags (React component, theme definition, API route and handler, data access, personal-data fields,
customer-data rendering, GDPR consent/deletion/export/retention...) and a whole-repository graph (importers, unused
exports, mounted routers). Tools: `repo_map`, `repo_find` (incl. route tracing and unused exports), `repo_tags`,
`search_layers`. Tag precision/recall are held to ≥ 0.95/0.9 on hand-labelled fixtures, and the index is checked against
the bench's exhaustive ground truth on fresh seeds (`bench/src/index-pack.tests.ts`).

**Tool set `index`:** `fs_read`, `fs_search` and the four index tools (`fs_list` dropped: the map replaces it).
`optimised-r2` answers classification and structure questions from the index: React components, customer-data UI, PII
declarations and GDPR handlers by tag; the theme by tag plus importers; endpoints from the route files' live routes;
dead exports from `unusedExports`; a route trace from `repo_find { route }`.

A first draft of the index tools carried verbose descriptions and tag enums in every schema (+985 tokens per request
after dropping `fs_list`); they were slimmed (tags are validated strings, listed once in `repo_tags`) to +517 tokens
before this round was recorded.

**Run:** `npm run bench -- --policies optimised-r2 --tools index --repeat 3 --fresh-seeds 42 --label round-2`.
Re-measured after the slice-15 review fixes with `--repeat 1` (the scripted tier is deterministic); `round-2.json`
holds that run. The headline is unchanged (median 4,844, p90 5,151); the families answered from the index cost 17-18
tokens more each (every index result now reports its `skipped` counts), and the fixes to route liveness, dead exports
and card reuse changed no answer on the generated repositories, whose conventions the old rules happened to fit.

| solver | runs | correct | target | stretch | median tokens | p90 tokens | median turns | p90 turns |
|---|---|---|---|---|---|---|---|---|
| reference (Round 1 run) | 200 | 100% | 100% | 0% | 3,882 | 14,936 | 2 | 3 |
| optimised-r2 | 200 | 100% | 100% | 16% | 4,844 | 5,151 | 2 | 2 |

Targeted families (median tokens, reference → optimised-r2, re-measured): dead exports 33,936 → 4,490 (-87%), route trace
16,158 → 4,528 (-72%, 5 → 2 turns), GDPR 14,936 → 4,635 (-69%, 4 → 2 turns), theme 7,595 → 4,528 (-40%, 3 → 2 turns),
React 5,118 → 4,956 (-3%); endpoints flat (+1%). Fresh seed 42: 100/100 correct.

**Regression found:** every one-search family got ~1,100 tokens dearer (e.g. find-file 3,438 → 4,573) because the
index schemas ride on every request while `fs_search` is still offered too; the median rose 25%.

**Decision: kept, conditional on Round 3.** The targeted multi-step tasks improve by 40-87% (spread across wordings and seeds ≤ 185 tokens) and
correctness stays 100%, but the median-token regression on one-search tasks is not acceptable on its own. Round 3 must
remove it; otherwise Round 2 would be reverted.
