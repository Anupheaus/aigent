# Phase 1 Foundation: Design

The full product vision and all phases are in the approved master plan (`C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`). This spec fixes the scope and decisions for the first implementation slice, "Phase 1 foundation core". Later slices (1a to 1g, 2 to 6) each get their own spec and plan.

## Scope of this slice

A working, fully unit-tested core that runs an agent task against a provider with strict tools, streaming, and atomic storage, using a deterministic `FakeProvider`. Real provider adapters, chat, scoring, compaction and the tool packs follow in later slices.

In scope:
1. Project tooling: vitest, fast-check, zod, ESLint-free for now (typecheck is the gate), `AGENTS.md`, CI workflow.
2. Normalised provider types and the `Provider` interface (streaming events, capabilities, usage).
3. `FakeProvider` (scripted turns, abort support, usage) in `testing/`.
4. Strict tool definitions: `defineTool`, `defineBatchTool`, zod to strict OpenAI-style JSON schema, required `deterministic`/`cache`/`describeActivity` flags, definition-time errors.
5. Tool execution: validation, structured failure envelopes, batch partial success, `aigent_multi`, parallel dispatch.
6. Keyed async write queue and the `Store` interface with an in-memory implementation (atomic compare-and-set).
7. Stream directive parser (`::aigent ...`) that is chunk-boundary safe.
8. Agent loop and `agent.task()` with the dual awaitable/async-iterable shape, `createAigent`, `ai.agent`, stop/limits basics.

Out of scope here (later slices): Anthropic and openai-compatible adapters, chat, scoring/report, cache, compaction/layout, memory, packs, resume, guardrails, scheduler, approvals.

## Decisions (made autonomously, to be reviewed)

- **JSON schema from zod**: use zod 4's built-in `z.toJSONSchema` then post-process into the strict subset (all properties required, `additionalProperties: false`, optionals as nullable-required). Reject unsupported types at definition time. Remaining wrapper only where the built-in output is not strict.
- **Style**: functional, no classes, hooks (`useXxx`) only where a domain returns a bag of operations; kebab-case files, `*.tests.ts` co-located, named exports, barrels only in `index.ts`.
- **Errors**: one `AigentError` factory function with a `code` union; no class hierarchy.
- **Provider contract**: `stream(request, signal) => AsyncIterable<ProviderEvent>`; non-streaming providers are adapted by a wrapper. Events: `text-delta`, `thinking-delta`, `tool-call` (complete arguments), `usage`, `done`.
- **Time and ids**: a `Clock` and `IdGenerator` are injected everywhere for determinism.
- **Node 20+, ESM only.**
- **Git**: work on branch `phase-1-foundation`, local commits only, no push.
