# Handoff: where the work stands and how to continue

Written 2026-10-21 at the end of an autonomous session. Another session can pick up from exactly here.

## 1. State at a glance

- Repo: `C:\Users\email\aigent` (package `@anupheaus/aigent`, TypeScript 7, ESM, Node 20+, Windows host). Remote `origin` = `git@github.com:Anupheaus/aigent.git`.
- Branch: `phase-1-foundation`. **All work is on this branch and is pushed** (HEAD `2a36b91`, working tree clean). Nothing is merged to `main`; no PR exists; nothing has been published and nothing should be until the owner says so.
- Health at HEAD: `npm run typecheck` clean, `npm run build` clean, `npm test` = **2,488 passed / 13 skipped** (skips are gated live tests and one Windows symlink test).
- Slices **1–10 are done** (built, independently reviewed, review findings fixed). Slice **11 is built and reviewed but its findings are NOT fixed**. Slice **12 is built but NOT reviewed**. Slices **13–20 are not started** (plans written).
- No agent/job is running. The owner asked that no further work be dispatched until they restart it.

## 2. Source of truth documents

| What | Where |
|---|---|
| Product vision and requirements (approved master plan, ~135 KB) | `docs/design/master-plan.md` (read it for any scope question) |
| Roadmap/status table | `docs/superpowers/roadmap.md` |
| Per-slice spec/plan (each has Global Constraints, Review Focus, binding interfaces) | `docs/superpowers/plans/*.md` (one per slice, listed in section 5) and `docs/superpowers/specs/*.md` |
| Repo rules for agents | `AGENTS.md` (also see `C:\code\personal\agents\agents.md`, `coding-standards.md`, `patterns.md`) |
| Public docs | `README.md` (feature docs per slice were added as each slice landed) |
| Review reports and fix reports | `.superpowers/sdd/<plan-name>/final-review.md` (git-ignored, on disk in this checkout). Many subagent *fix/implementation reports were refused by the harness and only returned as chat text*, so they are not on disk — the code, tests and plans are the source of truth. |

## 3. What exists (summary by slice)

1. **Foundation core**: `createAigent`, `agent.task()` (awaitable + async-iterable, stop/cancel/steer, limits, abort), strict zod tools → strict JSON Schema, `defineTool`/`defineBatchTool`, tool executor with structured envelopes, built-in `aigent_multi` (free-form `args` objects; the only non-strict tool), stream directive parser (`::aigent status|outcome|plan|todo`), keyed write queue, `Store` contract + in-memory store, `FakeProvider` (`@anupheaus/aigent/testing`).
2. **Providers**: OpenAI-compatible adapter (+ `deepseek`, `openai`, `ollama` presets), Anthropic adapter (prompt caching, thinking), SSE parser, provider **contract suite** at `@anupheaus/aigent/testing/contract` (optional vitest peer). Live tests exist but are skipped unless `AIGENT_LIVE=1` and keys/Ollama are present — **never run**.
3. **Model settings, resilience, scheduler**: settings resolution (task > agent > runtime > provider) and per-provider mapping, agent version hash, retry/backoff/first-event timeout/fallback models, shared scheduler (concurrency, RPM/TPM, lanes, fairness, 429 adaptation).
4. **Telemetry/scoring/feedback**: versioned run records and step traces, `redact`/`purge`/`captureContent`, `enableFeedback` (env-derived), `aigent_feedback`, `previous` outcome linking, user feedback (`ai.feedback`), `ai.report()` (scores relative to rolling baseline, findings, agent feedback summary), request analysis + tool suggestions, `ai.trace`.
5. **Tool cache, shapers, volatile block, plan/todo**: deterministic-aware cache with stats and single-flight; verbatim-safe shaper pipeline (`contentKind`/`fidelity`, originals by handle, `result_original`, alias table); trailing volatile block + prefix-stability monitor; `plan_complete` + `todo` tools and pinned definitions.
6. **Context layout/compaction/compression**: `ContextMessage` flags, cache-friendly layout and breakpoints, token-pressure compaction (stub → dedupe → single summary, hysteresis), `Compressor` interface with cache + protected spans + `agent.preview()` + `ai.evalCompression`. **No LLMLingua is shipped** (needs a model download) — interface only.
7. **Chat**: conversation model (plain-JSON snapshot + gapless patches + reducer + store), `agent.chat()`, shared turn runner, activity updates, persistence, `ask_user`, queue/steer/interrupt, threads, forks/branches, attachments, pins, reactions, auto-title.
8. **Resume + approvals**: checkpoints with snapshots, call ledger (exactly-once for side effects), fenced leases, `agent.resume()`/`ai.restoreAgent()`, chat turn resume, approvals (rules, `agent.approve`, audit trail, durable pending).
9. **Guardrails, dry-run, undo**: guardrail pipeline (secrets, pii, injection, scope, loop-guard, output-schema + retry loop), stream hold-back/retraction, dry-run with planned effects, effect log + `agent.undo`.
10. **Packs**: `FsPolicy` + `fsTools` (`./tools/fs`), data/format tools (`./tools/data`: json/csv/diff/regex/calc with worker-thread regex timeout), meta (`./tools/meta`: `delegate` with depth/fan-out/cycle limits).
11. **Web + code packs** (`./tools/web`, `./tools/code`): HttpPolicy with SSRF protection, `http_fetch`, `page_extract`, `web_search` (consumer provides a `SearchProvider`), `code_outline`/`code_find_symbol`/`code_references`.
12. **Shell + git packs** (`./tools/shell`, `./tools/git`): `ShellPolicy`/`ProcessRunner` (no shell, scrubbed env, tree-kill), `shell_run`, hardened read-only git tools, gated `git_commit`/`git_push`.

## 4. Outstanding work, in the order to do it

### 4a. Slice 11 — fix review findings (do first)
Read `.superpowers/sdd/2026-10-29-web-code-packs/final-review.md` (0 Critical, 8 Important, 15 Minor). The Important ones:
- **I1** DNS rebinding with the default `fetch` access (cannot pin the checked IP). Fix idea: make the pinning node access the default when `allowAnyPublic`/non-allowlisted hosts are possible, or refuse `allowAnyPublic` with the unpinned access.
- **I2** A batch with failed items is cached as a success, so retryable failures (e.g. 503) are replayed for minutes. Cache only fully successful (or per-item-ok) results.
- **I3** Result budgets too small: `page_extract` / `http_fetch` bodies get swapped for a cut-off JSON preview with a "page through it" hint the tools cannot honour. Add paging (offset/limit) or raise budgets.
- **I4** `page_extract` returns empty text for HTML lacking `</head>` or wrapped in `<form>`.
- **I5** Code pack blocks the event loop (4 s for 6000 tiny files); timeouts/aborts cannot stop a build.
- **I6** Each `codeTools()` call starts a compiler process that is never closed; add a dispose API and wire into `ai.close()`.
- **I7** `exported` flag wrong for `export { foo }` / `export default x`.
- **I8** `peerDependencies.typescript` range `>=7 <8` will make npm refuse consumers on TS 5/6 even though the peer is optional.
Context: TypeScript 7.0.2 has no classic compiler API; the code pack uses `typescript/unstable/sync` (separate compiler process).

### 4b. Slice 12 — review it, then fix
Not yet reviewed. Review scope = commits `206899d`, `5a3637f`, `1f8a3ae` (shell policy/runner, `shell_run`, git pack). Focus: argv injection corpus, allowlist bypass (path variants/symlink basenames/`PATH` tricks), env scrubbing, tree-kill (Windows `taskkill`), output caps, git hardening (hooks/fsmonitor/pager/editor/`GIT_*`), ref/path validation, commit/push gates and approval/dry-run/undo, resume `ask` behaviour. Known author notes: `allowShell` can only be `false`; `gitTools` needs a shell policy allowing `git` with empty `argRules`; git worktrees refused; main-thread responsiveness tests tolerate a 500 ms gap and one unidentified timing failure was seen once.

### 4c. Slices 13–20 (plans exist; follow each plan's tasks in order)
| # | Plan file | Scope |
|---|---|---|
| 13 | `2026-10-31-database-knowledge-packs.md` | `db_query` read-only pack (policy-validated filters, Mongo adapter via fake; live Mongo gated), knowledge/RAG pack (chunker, embedder, hybrid search, freshness, citations, retrieval eval) |
| 14 | `2026-11-01-plugins-mcp-claudecode.md` | `definePlugin`, MCP consuming plugin, separate **unpublished** `@anupheaus/aigent-claude-code` package + delegated-loop (`ownsLoop`) mode. Live spike against the real SDK/CLI is NOT done (needs the user's subscription); never read credential files; package stays `private` until the owner confirms the policy position |
| 15 | `2026-11-02-bench-optimisation.md` | `bench/` generator, ground truth, hint-linter, task catalogue with decoys/traps, scripted solvers, Round 0 baseline, optimisation rounds 1–3 (repo index, classification, ranked search, layered answers), budgets + CI gate. Only scripted tiers can run here (no model); do NOT use private repos under `c:\code\personal` (no permission given) |
| 16 | `2026-11-03-memory.md` | memory written only via tool-call `memory` field, recall into volatile block, tools, user-correction lessons |
| 17–18 | `2026-11-04-efficiency-learning.md` | model routing + response cache, strategy variants with guarded rollout, skill distillation with approval workflow |
| 19 | `2026-11-05-store-adapters.md` | store contract suite (`describeStoreContract`), multi-process-safe file store, Mongo store (fake-tested), store-backed vector index, embedding recall |
| 20 | `2026-11-06-packaging-docs-release.md` | exports audit, Changesets, release workflow (**write only, never run/publish**), API-extractor gate, TypeDoc, guides, `examples/`, CONTRIBUTING, final report with every ruling |

After each slice: update the row in `docs/superpowers/roadmap.md`, README and AGENTS.md.

### 4d. Known cross-cutting leftovers (from reviews; not blockers)
- Files over the ~200-line guideline: `src/core/run-agent-turns.ts`, `src/chat/chat-engine.ts`, `src/core/create-aigent.ts`, `src/tools/define-tool.ts`, `src/tools/execute-tool-call.ts`.
- Skipped Minors are recorded per slice in the review/fix reports (see section 2) — none known to be bugs with data-loss/security impact, but check the shell/git, web and fs ones when reviewing.
- Not testable here: real model behaviour, real provider wire formats (only fixtures), real MongoDB, Ollama, Claude Code SDK, GitHub Packages publish. Everything is built against interfaces/fakes with gated live tests.
- Anything privacy-related: `~/.npmrc` tokens were printed into an earlier transcript; the owner may want to rotate them.

## 5. How the work was run (the process to keep)

The repo uses the superpowers workflow: plan per slice → implement with TDD → independent review → fix wave. The loop that worked:

1. A slice plan exists in `docs/superpowers/plans/` (header with Global Constraints and Review Focus; tasks with binding interfaces and test lists).
2. **Implementer job** (opus subagent): implements all tasks of the slice with strict TDD, one commit per task using the plan's commit message, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Must run `npm run typecheck && npm test` before each commit, `npm run build` per task, `npm pack --dry-run` at the end.
3. **Reviewer job** (opus, read-only) on a **frozen git worktree** so the main tree can keep changing:
   `git worktree add -f ../aigent-review-N <sha> --detach` then `cmd //c "mklink /J node_modules ..\\aigent\\node_modules"` in the worktree. Diff package: `bash <skill>/scripts/review-package <plan> <base> <head>` (skill dir: `C:\Users\email\.claude\plugins\cache\claude-plugins-official\superpowers\6.4.1\skills\subagent-driven-development`). Findings go to `.superpowers/sdd/<plan-name>/final-review.md` with Critical/Important/Minor.
4. **Fix job** (opus) applies the findings (TDD, never weaken assertions), and was chained with the next slice's implementation to save a round trip; the next slice's review runs concurrently on a worktree.
5. Controller verifies (`typecheck`, `test`, `build`), updates the roadmap, pushes.

## 6. Conventions and gotchas (hard-won)

- Style (enforced by review): functional, no classes, max 2 params (options objects), named exports, barrels only in `index.ts`, `.js` import suffixes, no `any`, named constants, co-located `*.tests.ts`, test helpers named `*.test-support.ts` (excluded from the build and pack), 2-space/single quotes/semicolons/trailing commas, blank line at EOF.
- `.gitattributes` normalises to LF; some tooling wrote CRLF — check diffs for line-ending noise.
- **GitHub push protection blocks real-looking secrets in fixtures.** Build fake secrets at runtime (`'sk_' + 'live_…'`), never as a literal. (A history rewrite of unpushed commits was needed once.)
- The Bash tool strips backslashes in heredocs — use the Write tool for files containing regexes/Windows paths.
- Subagents' attempts to write report files into `.superpowers/sdd/...` were often refused by the harness; ask for the report in the reply instead.
- Windows specifics: plain symlink creation needs privileges (junction tests run, symlink tests skip with a reason); process-tree kill uses `taskkill /T /F`; transient `.git/objects` "Permission denied" occurred occasionally — retry.
- Never push `main`, never publish, never run the release workflow, no downloads other than npm packages (no Ollama/models), no live API calls without the owner. Pushing the feature branch was authorised by the owner.
- `Co-Authored-By` trailer text is exactly: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## 7. Decisions taken autonomously (owner has not reviewed all of them)

These were made while the owner was away; revisit if any is wrong:
- One review + fix wave per slice, fixes batched into the next slice's job; fix waves were verified by running the suite, not re-reviewed.
- `aigent_multi` takes free-form `args` objects (owner-requested); `strictSchema: false` is currently available to any tool definition, not only `aigent_multi` (consider restricting).
- `usage.turns` = model requests; each `aigent_multi` inner call counts individually in `toolCalls`; `toolCallsPerTurn` is recorded (owner-requested metric).
- Cache sharing: deterministic tools' cached results are shared only within the same agent unless `cacheNamespace`/`sharedCache: true`.
- Feedback (`enableFeedback`) defaults on outside `NODE_ENV=production`; resume, memory and learning features are opt-in.
- Compaction defaults: `compactAt` 0.75, `compactTo` 0.45, `keepRecent` 4, `minTurnsBetween` 3.
- Code pack uses `typescript/unstable/sync` because TypeScript 7 removed the classic API.
- Many smaller rulings are in the plans' "Rulings" notes and the per-slice reports; the final slice-20 task is to collect them all into `docs/superpowers/final-report.md`.

## 8. Suggested first moves for the next session

1. `git fetch && git checkout phase-1-foundation && git pull`; `npm ci`; run `npm run typecheck && npm test && npm run build` to confirm the baseline above.
2. Read this file, `docs/superpowers/roadmap.md`, then the slice-11 review file; fix slice 11 (4a).
3. Review slice 12 (4b), fix it.
4. Continue with slice 13 and onward using the loop in section 5.
5. Before any PR to `main`: finish slice 20 (docs/examples/API report), regenerate the final report, and ask the owner about publishing and the Claude Code plugin policy position.


---

## 9. Addendum 2026-10-27: offline work on branch `slices-18-20-offline`

Written by a second session that only had the GitHub copy of this repo (the owner's other PC, which the owner believes is further ahead, roughly slice 17, was switched off). **Everything here is on the separate branch `slices-18-20-offline`, cut from `phase-1-foundation` at `b89bcbc`. `phase-1-foundation` itself was not touched.** Nothing is merged to `main`, nothing is published.

### What was built (slice 19, the parts that need nothing from slices 13-17)
- `describeStoreContract` (`@anupheaus/aigent/testing/contract`): CAS exclusivity (100 writers, N rounds), copy semantics, awkward keys and collection names (`../x`, `CON`, case-only differences, 300-char keys, unicode), 5 MB values, delete, purge (including `purge({})` = every object record). Runs against in-memory, file and Mongo (fake) stores.
- `createFileStore` (exported from the main entry): `<dir>/<collection>/<key>.json`, per-record `.lock` file, temp file + fsync + rename, stale-lock takeover (a dead pid on the same host, or no heartbeat for `staleLockMs`; empty lock files aged by their real mtime; removal only under the stale token's exclusive break file, so concurrent takeovers leave one holder), `delete`, `purge`, `close`. Values must be JSON-serialisable. Test hook `beforeCommit` simulates a crash.
- `createMongoStore` / `connectMongoStore` (`@anupheaus/aigent/stores/mongo`, `mongodb` is an optional peer): documents `{ _id, version, json, store, purge }` (value as JSON text so `$`/`.` field names survive an update; 16 MiB checked before sending, `invalid_input`; lone-surrogate keys refused), conditional `updateOne`, duplicate key (11000) and WriteConflict (112) map to a failed CAS, purge limited to its own `store` field and real collections, reads never create collections, driver errors map to `store_failed` with `retryable`, index created once per collection, `close`. Built and tested against `mongo-fake.test-support.ts` only. **It has never run against a real MongoDB** (the live test from the plan was not written).
- `key-encoding.ts` (injective, case-safe, Windows-device-safe names), `purge-match.ts` (shared purge rule).
- Test helper `tempRoot` now retries removal (Windows delete-pending files); this may also be the cause of the `EBUSY` git test failures below, but those were not re-checked individually.
- New dev dependency: `esbuild` (the multi-process test bundles the store for child processes).

### Verified here (Windows 11, Node 24.22.1, TypeScript 7)
`npm run typecheck` clean, `npm run build` clean, `npm test`: everything passes **except git integration tests that already failed on the untouched branch** (3 or 4 of them per run: `git-read.integration` "never runs repository hooks...", `git-write.integration` x3; 5 s timeouts and `EBUSY`). They belong to slice 12 (still unreviewed) and are Windows timing/locking problems; look at them in the slice 12 review. One full run also failed `scoring/report-performance.tests.ts` (3 s budget) under load; it passes alone in about 1.5 s, so treat it as flaky on a busy machine.

### Known limits of the file store (review these)
- Stale-lock takeover has a small race window if two processes find the same stale lock at the same instant (mitigated by renaming and token checks, not eliminated). Only relevant after a crash.
- On Windows a just-released lock can report `EPERM`/`EACCES` on create; the lock treats that as "busy, retry" on win32 only.
- The 100-writer contention test takes real file locks one by one: 5 rounds for the file store (20 for in-memory) and a 100 s lock timeout in that test only. The default lock timeout is 10 s.
- `list` on a very large collection reads every file; there is no index.

### NOT done, and why
- **Slice 19 remainder**: the store-backed vector index and embedding recall need the knowledge pack (slice 13) and memory (slice 16).
- **Slice 18** (strategy variants, skill distillation): buildable in principle, but the plan shares files with slice 17 (`create-aigent.ts`, `agent-version.ts`) and "lessons" needs memory (16). The owner believes slice 17 exists on the other PC, so building 18 here would conflict heavily. Do it after merging the other PC's work.
- **Slice 20** (packaging, docs, examples): needs every entry point and feature to exist; do it last.

### How to merge
1. On the other PC: `git status -sb`, commit and push anything unpushed (to `phase-1-foundation` or its own branch).
2. Merge or cherry-pick `slices-18-20-offline` (2 code commits + the doc commit). Expected conflicts: `src/index.ts` (one export block), `src/testing/contract/index.ts`, `src/public-api.tests.ts` (export lists), `package.json` (`exports`, `peerDependencies`, `devDependencies`), `package-lock.json`, `AGENTS.md` and this file.
3. Run typecheck, tests and build; then continue with slices 13-17 on the merged line, and finish slice 19's vector index/embedding recall after 13 and 16 exist.
4. Git identity was not configured on this PC; commits on the branch are authored as `Tony Hales <jolopearce@gmail.com>` via repo-local config.
