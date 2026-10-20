# Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real streaming providers (OpenAI-compatible incl. DeepSeek/OpenAI/Ollama, and Anthropic) behind the existing `Provider` interface, proven by a shared contract suite and end-to-end tests on mocked HTTP.

**Architecture:** Both adapters are plain functions returning a `Provider`. They share a chunk-safe SSE parser, translate the normalised `ProviderRequest` into the vendor wire format, and stream vendor events back into `ProviderEvent`s. HTTP is injected (`fetch`) so every test runs offline with fixture SSE bodies.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), global `fetch`/`ReadableStream` (Node 20+), vitest, zod already present. No SDKs.

**Spec:** `docs/superpowers/specs/2026-10-21-providers-design.md` (builds on the foundation spec).

## Global Constraints

Same as `docs/superpowers/plans/2026-10-20-phase-1-foundation.md` Global Constraints (functional style, no classes, named exports, max 2 params, no `any`, `.js` import suffixes, named constants, `*.tests.ts` co-located, barrels only in `index.ts`, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus:
- No network access and no downloads in tests; live tests are skipped unless `AIGENT_LIVE=1` and the relevant env var is present.
- API keys come only from options; never include key values in errors or logs.
- Existing types are authoritative: `Provider`, `ProviderRequest`, `ProviderMessage`, `ProviderToolSpec` (has `strict: boolean`), `ProviderEvent`, `Usage`, `ToolCall` in `src/providers/provider-types.ts`; `createAigentError` codes `provider_failed` and `aborted`.

## Review Focus

1. A tool-call whose JSON arguments arrive split across many SSE chunks, or are malformed, must still yield exactly one `tool-call` event per call (raw string args when unparsable).
2. An SSE event split across network chunks (mid-line, mid-UTF-8 character, `\r\n` line endings) must parse identically to the unsplit stream.
3. HTTP 4xx/5xx, a stream that ends without a terminal event, and a mid-stream network error must surface as `provider_failed` with status/retryable details and never hang.
4. Abort during streaming must stop reading, cancel the body, and throw `aborted`; no further events after abort.
5. Parallel tool calls (multiple indices / content blocks) interleaved in the stream must keep distinct ids/names/arguments.

---

### Task 0: SSE parser

**Files:**
- Create: `src/providers/sse-parser.ts`
- Test: `src/providers/sse-parser.tests.ts`

**Interfaces:**
- Produces: `parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseMessage>` and `interface SseMessage { event?: string; data: string }`. Messages are yielded when a blank line terminates them. `data:` lines of one message are joined with `\n`. Comment lines (`:`) and unknown fields are ignored. A trailing message without a final blank line is yielded at end of stream. The literal `[DONE]` is NOT interpreted here (adapters handle it).

- [ ] **Step 1: Write failing tests** covering: simple messages; `event:` + `data:` pair; multi-line data joined with `\n`; `\r\n` and `\r` line endings; comments ignored; messages split at every byte boundary of a sample stream give identical output (loop over all split positions, feeding the stream as two `Uint8Array` chunks, and also a one-byte-at-a-time run); a multi-byte UTF-8 character (`é`, `日本`, an emoji) split across chunks decodes correctly (use `TextDecoder` with `{ stream: true }`); a final message with no trailing blank line is flushed at end; `data` with no space after colon (`data:x`) and with one leading space stripped only once. Helper in the test file: `streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array>`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/providers/sse-parser.tests.ts` → FAIL.
- [ ] **Step 3: Implement** with `TextDecoder('utf-8')` streaming decode, a line buffer that handles `\r\n`/`\r`/`\n`, field parsing per the WHATWG SSE rules (first colon splits field/value, one leading space stripped), and `reader.releaseLock()` / `reader.cancel()` in a `finally` so abandoning the iterator cancels the body.
- [ ] **Step 4: Run to verify pass**; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: add chunk-safe SSE parser`.

---

### Task 1: Provider contract suite + OpenAI-compatible provider

**Files:**
- Create: `src/testing/provider-contract.ts`, `src/providers/openai-compatible.ts`, `src/providers/openai-messages.ts`, `src/providers/openai-stream.ts`, `src/providers/http-error.ts`, `src/providers/presets.ts`
- Test: `src/providers/openai-compatible.tests.ts`, `src/providers/presets.tests.ts`, `src/testing/provider-contract.tests.ts` (runs the contract against `createFakeProvider` and the OpenAI adapter on fixtures)
- Modify: `src/testing/index.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `parseSse` (Task 0), provider types, `createAigentError`.
- Produces:
  - `openAiCompatible(options: OpenAiCompatibleOptions): Provider` where `OpenAiCompatibleOptions = { id: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; fetch?: typeof fetch; maxContextTokens?: number; supportsParallelToolCalls?: boolean }`. Posts to `${baseUrl}/chat/completions`.
  - Presets (all return `Provider`, accept `{ apiKey?: string; baseUrl?: string; fetch?: typeof fetch }`): `deepseek` (id `deepseek`, base `https://api.deepseek.com`), `openai` (id `openai`, base `https://api.openai.com/v1`), `ollama` (id `ollama`, base `http://localhost:11434/v1`, no key needed).
  - `describeProviderContract(subject: ContractSubject): void` in `src/testing/provider-contract.ts`, where `ContractSubject = { name: string; create(scenario: ContractScenario): Provider }` and `ContractScenario` is a discriminated union: `{ kind: 'text'; chunks: string[]; usage: Usage }`, `{ kind: 'tool-calls'; calls: ToolCall[]; usage: Usage }` (calls whose `args` are objects), `{ kind: 'malformed-tool-args'; name: string; rawArgs: string }`, `{ kind: 'http-error'; status: number }`, `{ kind: 'truncated-stream' }` (stream ends with no terminal event), `{ kind: 'slow-text'; chunks: string[] }` (chunks delivered with delays so abort can land mid-stream). The suite registers vitest tests asserting the behaviours in Review Focus 1, 3, 4, 5 plus: text deltas concatenate to the chunks; one `usage` event with the scenario's totals; last event is `done` with `finishReason` `stop` (text) / `tool_calls` (tools); tool calls arrive with the scenario ids/names/parsed args; malformed args arrive as the raw string; http-error rejects with `code: 'provider_failed'` and `details.status` and `details.retryable` true for 429/500, false for 400/401; truncated-stream rejects `provider_failed`; abort mid-stream rejects `aborted` and yields no events afterwards.

OpenAI wire mapping (implement exactly):
- Request body: `{ model, messages, stream: true, stream_options: { include_usage: true }, tools?, max_tokens? }` (`max_tokens` from `maxOutputTokens`; `tools` omitted when empty). Headers: `content-type: application/json`, `authorization: Bearer <apiKey>` only when `apiKey` set, plus `options.headers`.
- Tools: `{ type: 'function', function: { name, description, parameters, strict } }` with `strict` = the spec's `strict`.
- Messages: `system`/`user` → `{ role, content: text }`; `assistant` → `{ role: 'assistant', content: text || null, tool_calls?: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }` (if `args` is a string, send it as is); `tool` → `{ role: 'tool', tool_call_id, content: text }`.
- Stream: each SSE `data` is JSON `chat.completion.chunk` (ignore `[DONE]`; skip unparsable keep-alive/comment payloads with a thrown `provider_failed` only for JSON that is not an object). `choices[0].delta.content` → `text-delta`; `delta.reasoning_content` or `delta.reasoning` → `thinking-delta`; `delta.tool_calls[]` accumulate by `index` (`id`, `function.name` set once, `function.arguments` appended). `choices[0].finish_reason` is remembered (`stop`→`stop`, `tool_calls`/`function_call`→`tool_calls`, `length`→`length`, other/missing → `stop`). `usage` (final chunk, possibly with empty `choices`) → one `usage` event: `inputTokens=prompt_tokens`, `outputTokens=completion_tokens`, `cachedTokens=prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? 0`. At end of stream: emit one `tool-call` per accumulated index in index order (JSON.parse arguments; on failure or empty string use the raw string, empty → `{}`), then `usage` (if seen; if never seen emit zeros), then `done` (if finish reason absent and tool calls exist use `tool_calls`). If the body ends and no `finish_reason` and no `[DONE]` was ever seen → `provider_failed` ("stream ended before completion").
- Errors: non-2xx → read up to 2000 chars of body, throw `provider_failed` `{ details: { status, retryable: [408,409,429].includes(status) || status >= 500, body } }` with a message containing the provider id and status but NOT the api key. `fetch` rejection: if `signal.aborted` → `aborted`, else `provider_failed` with the cause message.
- Abort: pass `signal` to `fetch`; between SSE messages check `signal.aborted` and throw `aborted`; always cancel the body in `finally`.
- Capabilities: `streaming: true, toolCalling: true, parallelToolCalls: supportsParallelToolCalls ?? true, promptCaching: false, vision: false, maxContextTokens: maxContextTokens ?? 128_000`.

Test fixtures for the OpenAI adapter live in the test file as helper functions that build SSE bodies (`sseBody(events: string[]): string` joining `data: ...\n\n` lines, with `data: [DONE]`), served through a fake `fetch` that records `{ url, init }` so tests also assert: URL, auth header present/absent, request body shape (messages mapping incl. assistant tool_calls and tool role, tools with `strict`, `stream_options`), and that the key never appears in error messages. Use ReadableStream bodies, deliver chunked (and one test delivering the whole body byte by byte).

- [ ] **Step 1: Write failing tests** (`openai-compatible.tests.ts` for wire details, `presets.tests.ts` for ids/base URLs/default capabilities, `provider-contract.tests.ts` calling `describeProviderContract` for the FakeProvider subject and the OpenAI subject; the Fake subject builds turns from the scenario with `textTurn`/`toolTurn` and an HTTP-error/truncated/slow variant implemented by wrapping `stream` in the test to throw/hang as needed, so the contract tests that cannot apply to the fake are skipped via a `skip?: ContractScenario['kind'][]` option on `ContractSubject`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the files above (`openai-messages.ts`: pure message/tool mapping; `openai-stream.ts`: chunk → events accumulator, pure and unit-testable; `http-error.ts`: shared `failedResponseError(params)` used by both adapters; `presets.ts`).
- [ ] **Step 4: Run all tests + typecheck.**
- [ ] **Step 5: Export** `openAiCompatible`, `deepseek`, `openai`, `ollama` and types from `src/index.ts`; export `describeProviderContract` and its types from `src/testing/index.ts` (update `src/public-api.tests.ts` expectations).
- [ ] **Step 6: Commit** `feat: openai-compatible provider with deepseek/openai/ollama presets and contract suite`.

---

### Task 2: Anthropic provider

**Files:**
- Create: `src/providers/anthropic.ts`, `src/providers/anthropic-messages.ts`, `src/providers/anthropic-stream.ts`
- Test: `src/providers/anthropic.tests.ts`; extend `src/testing/provider-contract.tests.ts` with an Anthropic subject
- Modify: `src/index.ts`, `src/public-api.tests.ts`

**Interfaces:**
- Consumes: `parseSse`, `failedResponseError`, contract suite, provider types.
- Produces: `anthropic(options: AnthropicOptions): Provider`, `AnthropicOptions = { apiKey: string; baseUrl?: string; fetch?: typeof fetch; defaultMaxTokens?: number; promptCaching?: boolean; maxContextTokens?: number; version?: string }`. Defaults: `baseUrl` `https://api.anthropic.com`, `defaultMaxTokens` 4096 (the API requires `max_tokens`), `promptCaching` true, `version` `2023-06-01`, `maxContextTokens` 200_000. Provider id `anthropic`. Posts to `${baseUrl}/v1/messages`.

Anthropic wire mapping (implement exactly):
- Headers: `content-type: application/json`, `x-api-key: <apiKey>`, `anthropic-version: <version>`.
- Body: `{ model, max_tokens: maxOutputTokens ?? defaultMaxTokens, stream: true, system?, messages, tools? }`. `system` = all `system` role messages joined with blank lines; when `promptCaching`, send as `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`, else as a plain string; omitted when empty. `tools` = `[{ name, description, input_schema: parameters }]` (omitted when empty; `strict` is not sent).
- Messages: `user` → `{ role: 'user', content: text }`; `assistant` → `{ role: 'assistant', content: [text block if text non-empty, ...tool_use blocks { type: 'tool_use', id, name, input }] }` (if `args` is a string that parses to an object use the object, else `{}`); consecutive `tool` messages are merged into ONE `user` message whose content is `[{ type: 'tool_result', tool_use_id, content: text }, ...]` in order; a plain user message following tool results stays separate.
- Stream (SSE `event`/`data` JSON): `message_start` → remember `message.usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`); `content_block_start` with `content_block.type` `tool_use` → start accumulating `{ id, name }` for that block index; `text`/`thinking` blocks need no state; `content_block_delta`: `text_delta.text` → `text-delta`, `thinking_delta.thinking` → `thinking-delta`, `input_json_delta.partial_json` appended to that block's JSON; `content_block_stop` of a tool block → emit one `tool-call` immediately (parse JSON; unparsable → raw string; empty → `{}`); `message_delta` → `delta.stop_reason` (`end_turn`/`stop_sequence`→`stop`, `tool_use`→`tool_calls`, `max_tokens`→`length`, other→`stop`) and `usage.output_tokens`; `message_stop` → emit `usage` (`inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `outputTokens`, `cachedTokens = cache_read_input_tokens`) then `done`. `ping` ignored; `error` event → `provider_failed` with the error type/message. Body ending before `message_stop` → `provider_failed`.
- Errors/abort/capabilities as for the OpenAI adapter (`promptCaching: true` capability reflects the option, `vision: false`, `parallelToolCalls: true`).

- [ ] **Step 1: Write failing tests**: wire details (headers, body mapping incl. merged tool results, system caching on/off, `max_tokens` default/override, tool `input_schema` mapping, no key in errors), streaming (interleaved text and two tool_use blocks with partial JSON split across deltas, thinking deltas, usage with cache fields, stop reason mapping, `error` event, truncated stream), and the contract suite via an Anthropic subject whose fixture builder converts each `ContractScenario` into Anthropic SSE.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (`anthropic-messages.ts` pure mapping, `anthropic-stream.ts` pure accumulator).
- [ ] **Step 4: Run all tests + typecheck.**
- [ ] **Step 5: Export** `anthropic` and `AnthropicOptions` from `src/index.ts`; update `public-api.tests.ts`.
- [ ] **Step 6: Commit** `feat: anthropic provider`.

---

### Task 3: End-to-end through createAigent, live tests, docs

**Files:**
- Create: `src/providers/providers-end-to-end.tests.ts`, `src/providers/live.tests.ts`
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything above plus `createAigent`, `defineTool`.

- [ ] **Step 1: Write failing end-to-end tests** (two describe blocks, one per adapter, using mocked `fetch` fixtures): (a) a two-turn tool loop — first response streams a text delta plus two parallel tool calls (one valid, one with invalid args), second response streams the final answer — asserting the final `TaskResult` (`status`, `answer`, `usage.turns === 2`, `usage.toolCalls === 2`, `errors` has one validation failure), that the second HTTP request body contains the assistant tool calls and both tool results in the right vendor format, and the `usage` totals match the fixtures; (b) `aigent_multi` call carrying free-form `args` objects works through the adapter with `strict: false` for that tool only (assert the request's tool list: OpenAI `strict` false for `aigent_multi`, true for others); (c) `agent.task` cancel mid-stream produces `cancelled` and the fake body is cancelled.
- [ ] **Step 2: Run to verify failure, implement any gaps found** (fix adapters, not tests, when the loop reveals a real defect; record fixes in the report).
- [ ] **Step 3: Live tests** in `live.tests.ts`: `describe.skipIf(process.env.AIGENT_LIVE !== '1')`; sub-blocks for Ollama (`OLLAMA_MODEL`, default `qwen2.5:14b`, requires the server to answer `GET http://localhost:11434/api/tags`, else skipped), DeepSeek (`DEEPSEEK_API_KEY`, model `deepseek-chat`), Anthropic (`ANTHROPIC_API_KEY`, model from `ANTHROPIC_MODEL`, default `claude-haiku-5-5`). Each runs a tiny task with one deterministic tool and asserts `status: 'completed'` and `toolCalls >= 1`. They must be skipped (not failing) by default; verify with `npm test` output.
- [ ] **Step 4: Docs**: README gets a "Providers" section (construction examples for each, presets, how `provider:model` strings work, the `testing` contract suite for third-party providers, live test env vars) and AGENTS.md structure lists the new files.
- [ ] **Step 5: Full verification**: `npm run typecheck && npm test && npm run build && npm pack --dry-run`; pack contains no `*.tests.*`.
- [ ] **Step 6: Commit** `feat: end-to-end provider tests, gated live tests and docs`.

---

## Self-review

- **Spec coverage:** SSE parser (T0), OpenAI-compatible + presets + contract suite (T1), Anthropic (T2), end-to-end, live tests, docs (T3). `strict` on tool specs already exists, so no task needed.
- **Placeholders:** wire mappings are specified exhaustively; fixture builders are implementer-written test code against those mappings.
- **Type consistency:** `OpenAiCompatibleOptions`, `AnthropicOptions`, `ContractSubject`, `ContractScenario`, `SseMessage`, `failedResponseError` are named identically wherever used.
