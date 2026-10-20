# AGENTS.md

## Purpose

`@anupheaus/aigent` is a TypeScript framework for AI tools, context, prompt, and memory orchestration.

## Commands

- `npm run typecheck` - type-check everything, including tests.
- `npm test` - run the vitest suite (`src/**/*.tests.ts`).
- `npm run build` - compile to `dist/` (tests excluded).

## Structure

`src/` folders (tests are co-located as `*.tests.ts`):

- `core` - `createAigent`, agent loop and run control, event stream, task input, system prompt and brief, errors, run records (`run-record.ts`), model settings (`model-settings.ts` schema, `resolve-model-settings.ts` layering, `filter-provider-settings.ts` per-provider warnings) and the agent version hash (`agent-version.ts`, `canonical-json.ts`, `library-version.ts`, which must match `package.json`), provider resilience (`resilience-policy.ts` defaults/backoff, `stream-with-resilience.ts` retry and fallback, `first-event-timeout.ts`, `open-stream-iterator.ts` which opens a provider stream inside the caller's clean-up `try`, `open-turn-stream.ts` which wires them into a turn)
- `providers` - provider interface and normalised request/event types, SSE parser and request helper, `openAiCompatible` adapter and its `deepseek`/`openai`/`ollama` presets, `anthropic` adapter (`anthropic-messages.ts` request mapping, `anthropic-stream.ts` event accumulator), settings mapping per adapter (`openai-settings.ts`, `anthropic-settings.ts`; `provider-settings.ts` lists every setting key), `retry-after.ts` (header parsing for `details.retryAfterMs`), `secret-redaction.ts` (credential redaction applied to every adapter error). `providers-end-to-end.tests.ts` drives `createAigent` through both adapters on mocked `fetch`; `live.tests.ts` hits real services and is skipped unless `AIGENT_LIVE=1` (plus `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / a local Ollama server, see README "Live tests")
- `scheduler` - the shared `createScheduler` (`scheduler.ts`), its public types (`scheduler-types.ts`), per-key admission state (`key-state.ts`), lane and fairness order (`pick-next-waiter.ts`) and the sliding-window budget (`token-bucket.ts`). `fake-time.test-support.ts` is the fake clock and sleep for deterministic timing tests. The turn takes a lease per provider call in `core/leased-stream.ts`
- `tools` - strict tool definitions, registry, executor, `aigent_multi`, activity renderer
- `store` - store contract, in-memory store, keyed write queue
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
