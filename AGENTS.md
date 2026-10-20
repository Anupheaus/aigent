# AGENTS.md

## Purpose

`@anupheaus/aigent` is a TypeScript framework for AI tools, context, prompt, and memory orchestration.

## Commands

- `npm run typecheck` - type-check everything, including tests.
- `npm test` - run the vitest suite (`src/**/*.tests.ts`).
- `npm run build` - compile to `dist/` (tests excluded).

## Structure

`src/` folders (tests are co-located as `*.tests.ts`):

- `core` - `createAigent`, agent loop and run control, event stream, task input, system prompt and brief, errors
- `providers` - provider interface and normalised request/event types, SSE parser and request helper, `openAiCompatible` adapter and its `deepseek`/`openai`/`ollama` presets, `anthropic` adapter (`anthropic-messages.ts` request mapping, `anthropic-stream.ts` event accumulator). `providers-end-to-end.tests.ts` drives `createAigent` through both adapters on mocked `fetch`; `live.tests.ts` hits real services and is skipped unless `AIGENT_LIVE=1` (plus `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / a local Ollama server, see README "Live tests")
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
