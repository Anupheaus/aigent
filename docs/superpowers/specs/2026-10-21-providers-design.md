# Providers slice: Design

Builds on `2026-10-20-phase-1-foundation-design.md`. Adds real model access behind the existing `Provider` interface so `agent.task()` can run against Claude, DeepSeek, OpenAI and local Ollama.

## Scope

1. `ProviderToolSpec.strict` so the loop tells providers which tools use the strict schema subset (only `aigent_multi` does not).
2. A chunk-safe Server-Sent Events parser over `fetch` response bodies.
3. `openai-compatible` provider (`openAiCompatible`) plus presets `deepseek`, `openai`, `ollama`.
4. `anthropic` provider with optional prompt caching on the system block.
5. A shared provider contract suite (`@anupheaus/aigent/testing`) run against the FakeProvider and both adapters using recorded-style mocked HTTP fixtures (no network in default CI).
6. End-to-end test: `createAigent` tool loop through each adapter on mocked HTTP.
7. Live tests (Ollama, DeepSeek, Anthropic) that are skipped unless explicitly enabled by environment variables. No downloads, no network by default.

Out of scope: model settings/thinking/effort mapping, retry/fallback/scheduler, vision, prompt-cache accounting beyond usage mapping, non-streaming fallback.

## Decisions

- `fetch` is injectable (`fetch?: typeof fetch`) for tests; the default is global `fetch` (Node 20+). No SDK dependencies.
- Malformed tool-call JSON from the model is passed through as the raw string in `ToolCall.args`, so the existing argument validation produces a precise, retryable field error instead of the provider throwing.
- HTTP failures become `provider_failed` AigentErrors with `details: { status, retryable, body }` (`retryable` for 408/409/429/5xx). Retrying is a later slice.
- Abort: the adapter passes the signal to `fetch` and maps an abort to an `aborted` AigentError.
- Usage mapping: OpenAI-style `prompt_tokens`/`completion_tokens`, cached from `prompt_tokens_details.cached_tokens` or DeepSeek `prompt_cache_hit_tokens`; Anthropic `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` reported as input, cached = `cache_read_input_tokens`.
- Reasoning: OpenAI-style `reasoning_content`/`reasoning` deltas and Anthropic `thinking_delta` become `thinking-delta` events.
- API keys are only read from the options the consumer passes (never from files); key values never appear in errors.
