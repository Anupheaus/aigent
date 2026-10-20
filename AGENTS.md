# AGENTS.md

## Purpose

`@anupheaus/aigent` is a TypeScript framework for AI tools, context, prompt, and memory orchestration.

## Commands

- `npm run typecheck` - type-check everything, including tests.
- `npm test` - run the vitest suite (`src/**/*.tests.ts`).
- `npm run build` - clean `dist/` (`scripts/clean.mjs`), then compile to it (tests excluded).

## Structure

`src/` folders (tests are co-located as `*.tests.ts`):

- `core` - `createAigent`, agent loop and run control, event stream, task input, system prompt and brief, errors, per-run telemetry wiring (`run-telemetry.ts`: creates the trace recorder and timer, builds and persists the run's records), model settings (`model-settings.ts` schema, `resolve-model-settings.ts` layering, `filter-provider-settings.ts` per-provider warnings) and the agent version hash (`agent-version.ts`, `canonical-json.ts`, `library-version.ts`, which must match `package.json`), provider resilience (`resilience-policy.ts` defaults/backoff, `stream-with-resilience.ts` retry and fallback, `first-event-timeout.ts`, `open-stream-iterator.ts` which opens a provider stream inside the caller's clean-up `try`, `open-turn-stream.ts` which wires them into a turn)
- `providers` - provider interface and normalised request/event types, SSE parser and request helper, `openAiCompatible` adapter and its `deepseek`/`openai`/`ollama` presets, `anthropic` adapter (`anthropic-messages.ts` request mapping, `anthropic-stream.ts` event accumulator), settings mapping per adapter (`openai-settings.ts`, `anthropic-settings.ts`; `provider-settings.ts` lists every setting key; `provider-options.ts` keeps `providerOptions` from replacing fields an adapter sets), `retry-after.ts` (header parsing for `details.retryAfterMs`), `secret-redaction.ts` (credential redaction applied to every adapter error). `providers-end-to-end.tests.ts` drives `createAigent` through both adapters on mocked `fetch`; `live.tests.ts` hits real services and is skipped unless `AIGENT_LIVE=1` (plus `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / a local Ollama server, see README "Live tests")
- `scheduler` - the shared `createScheduler` (`scheduler.ts`), its public types (`scheduler-types.ts`), options validation (`scheduler-options.ts`), per-key admission state (`key-state.ts`), lane and fairness order (`pick-next-waiter.ts`) and the sliding-window budget (`token-bucket.ts`). `fake-time.test-support.ts` is the fake clock and sleep for deterministic timing tests. The turn takes a lease per provider call in `core/leased-stream.ts`
- `tools` - strict tool definitions, registry, executor (`execute-tool-call.ts`: cache and shaping hooks; `envelope-text.ts`: the tool message text, safe for results JSON cannot represent; `run-tool.ts`: timeout and abort race; result sizing and `maxResultTokens` truncation in `truncate-result.ts`; `batch-entries.ts`: batch result helpers), `aigent_multi` (traces each inner call), activity renderer
- `telemetry` - stored record types (`run-record.ts`, `RUN_RECORD_SCHEMA_VERSION`) and their zod schemas (`run-record-schema.ts`), `trace-recorder.ts` (collects steps while the loop runs, no I/O), `run-timer.ts` and `measure-queue.ts` (timings), `build-run-records.ts`, `redact.ts`, `record-writer.ts` (the only path to the store: redact, then the keyed write queue), `persist-run.ts` (failures become one warning), `read-trace.ts`, `purge-records.ts`, `retention.ts`, `estimate-tokens.ts`, `summarise-args.ts`, `digest-args.ts` (per-run salted argument digest, `TraceStep.argsHash`, used for repeat detection)
- `cache` - tool-result cache: public types (`cache-types.ts`), `cache-key.ts` (key and schema hash), `tool-cache.ts` (lookup/store/abandon over the store and the keyed write queue), `single-flight.ts`, `cache-stats.ts` (pure stat updates), `cache-entry.ts` (entry building, servability), `cache-index.ts` (LRU eviction), `cache-options.ts`, `is-cacheable.ts`, `cache-findings.ts` (`report.cache`). The executor's cache path is in `tools/execute-tool-call.ts` (a miss always releases its single-flight); `tools/bounded-lookup.ts` bounds a lookup by the run signal and the tool timeout; `tools/run-tool.ts` runs a tool within its limits. `tool-cache.test-support.ts` is the harness for cache tests
- `context` - prompt hygiene: `volatile-block.ts` (the trailing `# Current state` request message and its options), `prefix-hash.ts`, `stability-monitor.ts` (warns once per run when the prefix changes). The run side is `core/run-volatile.ts`
- `planning` - consumer plan and agent todo: `plan-schema.ts` (validation and types), `plan-state.ts` / `todo-state.ts` (the only state transitions, shared by tools and directives), `run-planning.ts` (per-run state, events, volatile extras and corrections), `plan-complete-tool.ts`, `todo-tool.ts`, `render-pinned.ts` (pinned definitions and status sections), `apply-directives.ts`. The run side is `core/run-planning-setup.ts` (registry, pinned message sync, final status)
- `shapers` - verbatim-safe result shaping: `shaper-types.ts` (`ContentKind`, `Fidelity`, `Shaper`), `shaper-registry.ts` (validation, built-in order), `run-shapers.ts` (pipeline and per-run `ShapingState`), `original-store.ts` (handles), `result-original-tool.ts`, `alias-table.ts` (aliases and `expandAliases`; `core/expand-call-aliases.ts` applies it only to tools with `acceptsAliases`), `shapers-setting.ts` (`shapers` validation), `builtin/` (one file per built-in shaper). `verbatim-corpus.test-support.ts` holds the tricky-file corpus the verbatim tests run. The run side is `core/run-shaping.ts`; `scoring/shaper-findings.ts` adds `net-negative-shaper`
- `store` - store contract (optional `delete` and `purge`), in-memory store, keyed write queue
- `feedback` - `enableFeedback` resolution (`resolve-enable-feedback.ts`), the prompt addendum, the `aigent_feedback` tool and its per-run collector, stored feedback record types and collection names (`feedback-records.ts`), user feedback (`user-feedback-schema.ts` validation, `user-feedback.ts` storing it via the `responses` index and setting `userVerdict`), `previous` parsing (`previous-outcome.ts`) and the schema wrapper that adds it (`with-feedback-fields.ts`). The loop side lives in `core`: `link-previous.ts` strips and links `previous`, `dispatch-tool-call.ts` starts each call, `build-agent-registry.ts` adds the built-in tools
- `scoring` - `ai.report()`: public types (`report-types.ts`), pure `scoreRuns` (`score.ts`, `score-reliability.ts`, `score-format.ts`) against the rolling baseline (`baseline.ts`), per-run figures (`run-metrics.ts`, `pricing.ts`, `stats.ts`), findings (`findings.ts` over `tool-findings.ts` and `run-findings.ts`, with `finding-rules.ts` and `work-steps.ts`), `report-filter.ts`, `compare-versions.ts`, `agent-feedback-summary.ts` (`report.agentFeedback`), `agent-report.ts`, `report.ts` (pure assembly) and `read-report.ts` (store reading). `fixtures.test-support.ts` builds run records and traces with known numbers
- `analysis` - request analysis for `ai.report()`, pure functions over runs with their steps: `trace-group.ts` (similar-task grouping), `request-efficiency.ts` (cheapest successful path, typical cost, saving), `wasted-steps.ts`, `sequence-mining.ts` and `tool-suggestions.ts`. `analysis-fixtures.test-support.ts` holds the flailing and direct "find a file" runs
- `streaming` - chunk-safe `::aigent` directive parser and schemas
- `testing` - `FakeProvider` helpers, public as `@anupheaus/aigent/testing`. It must never load vitest (`testing-entry.tests.ts` checks its import graph).
- `testing/contract` - the vitest-based `describeProviderContract` suite every provider must pass, public as `@anupheaus/aigent/testing/contract` (vitest is an optional peer dependency)

Test-only helpers shared between test files are named `*.test-support.ts` (excluded from the build, never exported), e.g. the fake `fetch` and the OpenAI and Anthropic SSE fixtures in `providers`.

Public entry points are the barrels `src/index.ts` (`@anupheaus/aigent`), `src/testing/index.ts` and `src/testing/contract/index.ts`; `src/public-api.tests.ts` pins their exact runtime exports.

## Rules

Read `C:\code\personal\agents\agents.md`, `C:\code\personal\agents\coding-standards.md` and `C:\code\personal\agents\patterns.md` first.

- ESM only, Node 20+, TypeScript `strict`, `module`/`moduleResolution` `NodeNext`: relative imports end in `.js`.
- Functional style: no classes, no `this`. Named exports only. `index.ts` files are barrels only.
- 2-space indent, single quotes, semicolons, trailing commas, blank line at end of file, numeric separators (`60_000`).
- No `any`. Explicit return types on exported functions. Max 2 parameters per function; use an options object for 3+.
- Descriptive loop variable names (no `i`, `item`). No magic values: use named constants. JSDoc on exported interfaces/fields.
- Tests co-located as `*.tests.ts`, vitest. Comments explain why.
- Errors via `createAigentError` only. Error messages include ids/values and what was expected.
- Commits: small, local only, on branch `phase-1-foundation`. End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never push. No downloads other than npm packages named in Task 0.
