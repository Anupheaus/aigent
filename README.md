# @anupheaus/aigent

TypeScript framework for AI tools, context, prompt and memory orchestration. It wraps an LLM provider with a streaming agent loop, strict schema-validated tools, structured tool results and atomic per-agent storage, so agents are easy to build, observe and test.

## Install

The package is published to GitHub Packages. Point the `@anupheaus` scope at that registry, then install:

```sh
echo "@anupheaus:registry=https://npm.pkg.github.com" >> .npmrc
npm install @anupheaus/aigent
```

Requires Node 20 or later. ESM only.

## Quick start

This uses the deterministic fake provider from `@anupheaus/aigent/testing`, so it runs with no network or API key.

```ts
import { z } from 'zod';
import { createAigent, defineTool } from '@anupheaus/aigent';
import { createFakeProvider, textTurn, toolTurn } from '@anupheaus/aigent/testing';

const add = defineTool({
  name: 'add',
  description: 'Adds two numbers.',
  args: z.object({ a: z.number(), b: z.number() }).strict(), // argument objects must be strict
  deterministic: true,
  cache: false,
  describeActivity: args => ({ title: `Adding ${args.a} + ${args.b}` }),
  run: async ({ a, b }) => a + b,
});

const provider = createFakeProvider({
  turns: [
    toolTurn([{ id: 'call-1', name: 'add', args: { a: 2, b: 3 } }]),
    textTurn('2 + 3 = 5'),
  ],
});

const aigent = createAigent({ providers: [provider] });
const agent = aigent.agent({ name: 'calculator', model: 'fake:any-model', tools: [add] });

const run = agent.task({ task: 'What is 2 + 3?' });
for await (const event of run) console.log(event.type); // tool-call, tool-activity, usage, tool-result, text-delta, usage, done
const result = await run;
console.log(result.status, result.answer); // completed 2 + 3 = 5
await aigent.close();
```

`agent.task()` validates its input synchronously, then runs in the background. The returned run is both an async iterable of events (any number of consumers, before, during or after the run) and a promise of the final `TaskResult`.

## Providers

A provider connects agents to a model service. Pass every provider you use to `createAigent`. Each agent then picks one with its `model` string, written `provider:model`. The string is split at the first colon only, so model ids that contain colons work: `ollama:qwen2.5:14b` uses provider `ollama` with model `qwen2.5:14b`.

```ts
import { anthropic, createAigent, deepseek, ollama, openai, openAiCompatible } from '@anupheaus/aigent';

const aigent = createAigent({
  providers: [
    anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }), // id 'anthropic'
    deepseek({ apiKey: process.env.DEEPSEEK_API_KEY }),     // id 'deepseek'
    openai({ apiKey: process.env.OPENAI_API_KEY }),         // id 'openai'
    ollama(),                                               // id 'ollama', local server, no key
    // Any other OpenAI-compatible server (vLLM, LM Studio, a gateway...):
    openAiCompatible({ id: 'local', baseUrl: 'http://localhost:8000/v1', apiKey: 'optional' }),
  ],
});

const claude = aigent.agent({ name: 'writer', model: 'anthropic:claude-sonnet-5-5' });
const local = aigent.agent({ name: 'helper', model: 'ollama:qwen2.5:14b' });
```

- **`anthropic(options)`** uses the streaming Messages API at `https://api.anthropic.com/v1/messages`.
  - `apiKey` is required.
  - Optional: `baseUrl`, `fetch`, `defaultMaxTokens` (default 4096), `maxContextTokens` (default 200,000) and `version` (`anthropic-version`, default `2023-06-01`).
  - `promptCaching` (default true) marks the system prompt as a cache breakpoint.
- **`openAiCompatible(options)`** posts to `${baseUrl}/chat/completions`.
  - Required: `id` (the `provider:` prefix) and `baseUrl`.
  - Optional: `apiKey` (sent as a bearer token), extra `headers`, `fetch`, `maxContextTokens` (default 128,000) and `supportsParallelToolCalls`.
  - `tokenLimitField`: the body field `maxOutputTokens` goes to, `max_tokens` (default) or `max_completion_tokens`.
  - `isReasoningModel(model)`: says which models are reasoning models. They get `reasoning_effort` and have `temperature`, `topP` and `stop` dropped with a warning (they reject them); other models have `effort` dropped. Without it, a request that sends `reasoning_effort` is treated as one for a reasoning model.
- **Presets** are `openAiCompatible` with a fixed id and base URL. Each takes optional `apiKey`, `baseUrl`, `fetch` and `isReasoningModel`. `openai()` sends `max_completion_tokens` and treats `o1`, `o3`, `o4-mini`, `gpt-5` and other `o<digit>` / `gpt-5` models as reasoning models.

  | Preset | Id | Default base URL |
  | --- | --- | --- |
  | `deepseek()` | `deepseek` | `https://api.deepseek.com` |
  | `openai()` | `openai` | `https://api.openai.com/v1` |
  | `ollama()` | `ollama` | `http://localhost:11434/v1` |

All adapters stream over `fetch` (Node 20+), with no vendor SDK. Their shared behaviour:

- **Keys** come only from the options you pass. Every credential header value (the key, the bearer token, and custom headers such as `api-key`) is replaced with `[REDACTED]` in error messages and `details`, even when a server echoes it back in its error body. Values shorter than 8 characters are not treated as secrets.
- **Tool calls:** tools are sent with the `strict` flag where the API has one (OpenAI-compatible `strict: true`, `aigent_multi` with `strict: false`). Strict decoding is a request, not a guarantee: OpenAI does not guarantee schema conformance for parallel tool calls unless `parallel_tool_calls` is false, and DeepSeek honours `strict` only on its `/beta` base URL. The loop validates every call's arguments against the tool schema either way. Malformed tool-call JSON from the model reaches the loop as the raw string, so the model gets a precise validation error it can fix.
- **Failures:** HTTP errors become `provider_failed` errors with `details.status` and `details.retryable` (true for 408, 409, 429 and 5xx), plus `details.retryAfterMs` when the server sent a `retry-after` header. The message includes the server's own reason when the body has one. Dropped connections and streams cut off before their final event are `provider_failed` with `details.retryable: true` and no `status`. A 2xx response that is not `text/event-stream` fails with its content type and body. A failure that retries and fallback models (see [Retries, timeouts and fallback models](#retries-timeouts-and-fallback-models)) cannot recover ends the run with status `failed`. Stopping a run aborts the HTTP request and cancels the response body.
- **Usage:** a `usage` event is emitted only when the server reports usage; it is left out, never reported as zeros, when the server sends none.
- **Thinking blocks:** with Anthropic thinking on (including through `effort`), each completed `thinking` block (with its signature) and `redacted_thinking` block reaches the loop as a `thinking-block` provider event. The loop keeps them on the turn's assistant message (`ProviderMessage.thinkingBlocks`) and the adapter sends them back unmodified, ahead of the turn's `tool_use` blocks, as the API requires. They are opaque replay data, so they are not emitted as run events; `thinking-delta` events carry the readable text. A provider that does this declares `capabilities.thinkingBlocks: true`.
- **Empty assistant turns:** an assistant turn with no text and no tool calls is left out of the request, because both APIs reject it. Adjacent messages from the same role are then merged so roles keep alternating.
- **`fetch` option:** inject your own for proxies or tests.

### Testing a provider you write

A custom provider implements the `Provider` interface. `@anupheaus/aigent/testing/contract` holds the vitest suite the built-in adapters pass. It needs `vitest` (an optional peer dependency), so import it only from test files:

```ts
// my-provider.test.ts
import { describeProviderContract } from '@anupheaus/aigent/testing/contract';

describeProviderContract({
  name: 'my-provider',
  // Return a provider that reproduces `scenario` (text, thinking, length cut-off, parallel tool calls,
  // malformed args, HTTP error, truncated stream, mid-stream network error, slow text for abort) on its
  // first `stream` call, e.g. with a fake `fetch`. `thinking-round-trip` spans two calls (see below).
  create: scenario => myProvider({ fetch: fakeFetchFor(scenario) }),
  // Lets the suite check the response body is cancelled on abort and early break.
  observe: () => ({ isBodyCancelled: lastFakeBodyWasCancelled() }),
  skip: [], // scenario kinds that cannot apply to your provider
});
```

A wire-level fixture must stream tool arguments exactly as the scenario's `argumentFragments` / `rawArgsFragments` (one delta per fragment, calls interleaved), wait `delayMs` before each `slow-text` chunk, and deliver bodies in small byte chunks; `chunkBytes(text, size)` from the same entry does the last part.

The suite also checks that `capabilities.supportedSettings` is an array of known setting keys (use `[]` for none). A provider declaring `capabilities.thinkingBlocks: true` must pass `thinking-round-trip`: the first call streams the scenario's thinking blocks and then its tool call, and the second call must be answered only when the request replays those blocks unmodified ahead of the tool call (a fixture answers HTTP 400 otherwise, as the Anthropic API does). Providers that do not declare it skip that test.

### Live tests

The default `npm test` never touches the network. The tests in `src/providers/live.tests.ts` run a small tool-using task against real services. They are skipped unless `AIGENT_LIVE=1`, and each provider is also skipped when its prerequisite is missing:

| Provider | Needs | Model |
| --- | --- | --- |
| Ollama | a server answering `http://localhost:11434/api/tags` | `OLLAMA_MODEL` (default `qwen2.5:14b`) |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-haiku-5-5`) |

```sh
AIGENT_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run src/providers/live.tests.ts
```

## Model settings

Settings can be given at four levels. Each field is taken from the highest level that sets it: task, then agent, then `createAigent({ modelSettings })`, then `createAigent({ providerModelSettings: { [providerId]: ... } })`. `providerOptions` is the exception: it is keyed by provider id (`{ anthropic: { ... }, openai: { ... } }`), each provider's entry is shallow-merged across levels with higher levels winning per key, and each provider, a fallback included, receives only its own entry.

```ts
const aigent = createAigent({
  providers: [anthropic({ apiKey }), deepseek({ apiKey: deepseekKey })],
  modelSettings: { maxOutputTokens: 4000 },
  providerModelSettings: { deepseek: { temperature: 0.2 } },
});
const agent = aigent.agent({ name: 'writer', model: 'anthropic:claude-sonnet-5-5', modelSettings: { effort: 'medium' }, version: 'prompt-b' });
agent.task({ task: 'Draft the summary', modelSettings: { temperature: 0.7, thinking: 'off' } });
```

| Setting | Values | OpenAI-compatible | Anthropic |
| --- | --- | --- | --- |
| `maxOutputTokens` | positive integer | `max_tokens`, or `max_completion_tokens` (the `openai` preset) | `max_tokens` (default `defaultMaxTokens`) |
| `temperature` | 0 to 2 | `temperature` | `temperature`, dropped while thinking is on (the API requires the default) |
| `topP` | 0 to 1 | `top_p` | `top_p`, dropped when `temperature` is also set (current models reject both) and, while thinking is on, when below 0.95 |
| `thinking` | `'off'`, `'on'`, `{ budgetTokens }` (at least 1024) | not supported | `'on'` uses a budget of `min(maxOutputTokens - 1, 8000)` (8000 when `maxOutputTokens` is unset, never below 1024) |
| `effort` | `'low'`, `'medium'`, `'high'`, `'max'` | `reasoning_effort` (`max` sends `high`), not sent when `thinking` is `'off'` or to a model `isReasoningModel` rejects; sending it drops `temperature`, `topP` and `stop` | a thinking budget of 2048, 8000, 16000 or 32000 when `thinking` is unset, lowered to `maxOutputTokens - 1` (never below 1024) when that is set |
| `promptCaching` | boolean | not supported | overrides the adapter's `promptCaching` option |
| `stop` | up to 4 non-empty strings | `stop` | `stop_sequences` |
| `seed` | non-negative integer | `seed` | not supported |
| `providerOptions` | object of objects, keyed by provider id | its entry is merged into the request body; keys the adapter sets itself (`model`, `messages`, `stream`, `stream_options`, `tools` and the fields above) are ignored with a warning | same, with `system`, `stop_sequences` and `thinking` also reserved |
| `contextSize` | positive integer | runtime only, never sent | runtime only, never sent |
| `showThinking` | boolean (default true) | runtime only: `false` hides `thinking-delta` events | same |

With Anthropic thinking on, `max_tokens` must exceed the budget, so it is raised to the budget + 1024 when it would not. When that overrides your `maxOutputTokens` (an explicit `budgetTokens` at or above it, or a cap of 1024 or less) the run emits a `warning` saying so.

Invalid values are rejected up front: agent, `createAigent` and per-provider settings throw `invalid_definition` naming each bad field, and task settings throw `invalid_input`. A setting the provider cannot honour is never sent. The run emits one `warning` event per such setting instead, for example `Provider 'deepseek' does not support setting 'thinking'; ignored`. A provider lists what it can map in `capabilities.supportedSettings`; a custom provider that leaves the list out is treated as supporting none, with one warning saying so. It can also reject combinations through `unsupportedSettings(settings, { model })`, such as Anthropic's `temperature` with thinking on, and report how it will honour the settings it keeps through `settingsWarnings(settings, { model })`; each becomes a `warning`.

### Agent versions

Every agent has an `agentVersion`: a sha-256 of everything that shapes its behaviour. That covers the model, persona, skillset, context, effective settings (agent, runtime and provider levels), limits, the definition's `version` label, each tool's contract (name, description, schema and flags) and the library version. It also covers each fallback model with its own effective settings, and the resilience policy with defaults filled in. It does not depend on `name` or `instanceId`, on key order, or on empty and default-valued fields: `resilience: {}`, `fallbackModels: []`, `limits: {}` and empty `providerOptions` hash the same as leaving them out. Each run record in the `runs` collection stores `agentVersion`, `model` and the `version` label, so results can be compared across agent revisions. It also stores the settings as actually sent: `settings` is what the agent's model received (after its provider dropped what it cannot honour, with only that provider's `providerOptions` entry), `droppedSettings` names the resolved settings it left out, `runtimeSettings` holds `contextSize` / `showThinking` when set, and `fallbacks` lists `{ model, settings, droppedSettings? }` for each fallback model the run actually used.

**Privacy:** `providerOptions` are stored in run records exactly as configured, for the primary model and each fallback used. Keep API keys, user identifiers and other personal data out of them, or remove them with the `redact` hook (see [Telemetry](#telemetry-run-records-traces-and-privacy)), which sees these fields like every other stored field.

## Retries, timeouts and fallback models

Provider calls are retried and can fall back to other models:

```ts
const agent = aigent.agent({
  name: 'writer',
  model: 'anthropic:claude-sonnet-5-5',
  fallbackModels: ['openai:gpt-5', 'deepseek:deepseek-chat'],
  resilience: { maxRetries: 3, firstEventTimeoutMs: 30_000 },
});
```

| Policy field | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | 2 | retries per model after a retryable failure |
| `baseDelayMs` | 500 | first retry delay; doubles for each further retry |
| `maxDelayMs` | 20,000 | cap on the delay before jitter |
| `jitter` | 0.2 | each delay is spread by ±20% |
| `firstEventTimeoutMs` | none | a request with no event within this time is aborted and counts as a retryable failure |
| `fallbackOnNonRetryable` | false | also fall back after a non-retryable failure such as 400 or 401 |

- **What is retried:** `provider_failed` errors with `details.retryable: true`. That covers 408, 409, 429 and 5xx responses, dropped connections, streams cut off early and first-event timeouts.
- **`retry-after`:** when the server sends this header, it is a floor on the delay. Adapters put it on the error as `details.retryAfterMs`, from either seconds or an HTTP date. A `retry-after` longer than `maxDelayMs` (a spent quota, typically) is not waited for: the turn moves to the next fallback model at once, or fails when there is none. A 429 pauses the scheduler key for at most `maxDelayMs` too.
- **Never replayed:** a call is retried only if it failed before its first event. Once any text, thinking or tool call has reached you, a failure ends the run instead. You never see duplicated output.
- **Fallback order:** when a model's retries are used up, the turn moves to the next `fallbackModels` entry. Each turn starts again with the agent's own `model`. A fallback provider gets the same resolved settings. Any it cannot honour produce their warnings the first time the run uses that provider.
- **Stopping:** `stop()`, `cancel()` and `timeoutMs` end a backoff wait at once, and nothing further is sent.

Each retry emits `{ type: 'retry', attempt, delayMs, model, reason }` and each fallback emits `{ type: 'fallback', from, to, reason }`. `TaskResult.usage` and the run record count them in `retries` and `fallbacks`. Pass `sleep` and `random` to `createAigent` to control waiting and jitter in tests.

## Scheduler: shared limits, priorities and fairness

Every provider call waits for a lease from a scheduler, so agents sharing a provider respect its limits. By default there are no limits and calls start at once. To set limits, pass `SchedulerOptions`. To share limits across several `createAigent` instances, pass one `createScheduler()` to each of them:

```ts
import { createAigent, createScheduler } from '@anupheaus/aigent';

const scheduler = createScheduler({
  limits: {
    anthropic: { maxConcurrent: 4, requestsPerMinute: 50, tokensPerMinute: 400_000 },
    'anthropic:claude-opus-5': { maxConcurrent: 1 }, // a provider:model key wins over the provider key
  },
  defaultLimits: { maxConcurrent: 8 }, // for providers without an entry, per provider
});
const aigent = createAigent({ providers, scheduler }); // or: scheduler: { limits: { ... } }
```

- **Validation:** `maxConcurrent`, `requestsPerMinute` and `tokensPerMinute` must be positive integers and `maxBackgroundWaitMs` a non-negative integer. `createScheduler` (and `createAigent` given options) throws `invalid_definition` naming each bad field and its value, and rejects unknown keys, since a limit of 0 would queue every call forever and a misspelt key would silently mean no limit.
- **Admission:** a call starts when the key's in-flight count is below `maxConcurrent` and its per-minute budgets have room. It must also not be in a rate-limit pause. The token cost is estimated at admission as the request JSON length / 4 plus `maxOutputTokens` (1024 when unset). It is corrected with the actual usage when the call ends.
- **Per-minute budgets:** `requestsPerMinute` and `tokensPerMinute` hold in every sliding 60 s window. A spent amount returns exactly 60 s after it was spent. A plain continuously refilling bucket would allow up to twice the limit in one window. A single request larger than the whole token budget is let through only when the window is otherwise empty.
- **Lanes:** a task's `priority` is `'interactive'` or `'background'`. It defaults to `'background'` for `unattended` tasks and `'interactive'` otherwise. Interactive calls go first. A background call that has waited longer than `maxBackgroundWaitMs` (default 60 s) joins the interactive lane, so it is never starved.
- **Fairness:** within a lane, the agent served least recently goes next. An agent with many queued calls delays another agent's call by at most one admission.
- **Rate limits:** a 429 from a provider pauses that key for its `retry-after` (1 s without one). The key then runs at half its `maxConcurrent` for the next 10 admissions. Call `reportRateLimit` and `reportUsage` yourself for calls made outside aigent.
- **Leases:** a lease is held only while the provider streams, not while tools run. Each retry takes a new one. The first-event timeout starts once the lease is granted, so queueing never counts as a silent stream. Stopping a run removes a queued call at once and releases a held lease.
- **Queued events:** a call that cannot start at once emits `{ type: 'queued', position, reason, waitMs? }`. `position` is its 1-based place in admission order (lane, then fairness) when it joined the queue, not its arrival order, so an interactive call behind five background ones reports 1. `reason` is `'concurrency'`, `'requests-per-minute'` (also used for a 429 pause) or `'tokens-per-minute'`. `waitMs` is present when the wait is known. No event is emitted for a call admitted immediately.
- **Inspection:** `scheduler.snapshot()` returns `{ inFlight, queued, interactiveQueued, backgroundQueued }` for each limit key.

`Scheduler` is an interface (`acquire`, `reportRateLimit`, `reportUsage`, `snapshot`), so a cross-process implementation can replace the in-memory one.

## Events

A run yields these events, in order, ending with `done`:

| Event | When |
| --- | --- |
| `text-delta`, `thinking-delta` | model output (thinking is hidden when `showThinking` is false) |
| `tool-call`, `tool-activity`, `tool-result` | a tool call, its activity rows and its result envelope |
| `directive` | a parsed `::aigent` directive |
| `usage` | token usage reported by the provider for a turn |
| `queued` | a provider call is waiting for the scheduler |
| `retry` | a provider call failed before its first event and will be retried |
| `fallback` | a turn moved to the next fallback model |
| `warning` | something was ignored or cut short, such as an unsupported setting or a malformed directive |
| `error` | the run failed |
| `done` | the final status and the answer's `responseId`, after the run's records are written |

## Stopping a run

```ts
run.stop({ mode: 'graceful' }); // finish the current turn, then stop (status 'stopped')
run.stop();                      // immediate (default): abort now (status 'cancelled')
run.cancel();                    // alias for stop({ mode: 'immediate' })
```

Repeated calls, and calls after the run has settled, are no-ops. A task can also take `limits` (`maxTurns`, `maxToolCalls`, `timeoutMs`) and an `AbortSignal`. Reaching `maxTurns` or `timeoutMs` ends the run with status `limit_reached`. `maxToolCalls` does not end the run: calls past it (including calls inside `aigent_multi`, which each count) are refused with a `tool_call_limit` envelope the model can see, and the run continues.

## Strict tools and `aigent_multi`

Tool argument schemas must be zod objects declared with `.strict()`. They are converted to the strict JSON Schema subset: every key is required, optional keys accept `null`, and unknown keys are rejected. Providers send these tools with strict decoding (`ProviderToolSpec.strict: true`).

Every agent also gets the built-in `aigent_multi` tool, which runs several different tools in one model call. Each call is `{ id, tool, args }`, where `args` is the argument object for that tool:

```json
{ "calls": [
  { "id": "a", "tool": "add", "args": { "a": 2, "b": 3 } },
  { "id": "b", "tool": "read_file", "args": { "path": "src/index.ts" } }
] }
```

A strict schema cannot describe every inner tool's arguments, so `aigent_multi` is the only built-in non-strict tool. It opts out with `strictSchema: false`, its `args` is `{ "type": "object", "additionalProperties": true }`, and providers send it with `strict: false`. Each inner call is still validated against its own tool's strict schema and limited by its own `timeoutMs`; the `aigent_multi` call itself allows as long as its slowest inner tool, plus a small margin. A tool you define can opt out the same way, but only do this when a strict schema cannot express its arguments.

## Usage and efficiency

`TaskResult.usage` (also stored on the run record) reports tokens plus:

- `turns`: model requests (LLM round trips). An `aigent_multi` call is part of the turn that made it.
- `toolCalls`: tool calls actually executed. Each call inside `aigent_multi` counts individually; refused calls do not count.
- `retries` and `fallbacks`: provider calls retried, and turns moved to a fallback model.
- `toolCallsPerTurn`: `toolCalls / turns`, or 0 when no request was made. Every turn re-sends the conversation, so doing the same work in fewer turns is more efficient. For example, 50 tool calls in 3 turns gives about 16.7. Batch tools and `aigent_multi` raise this number.

## Telemetry: run records, traces and privacy

With a `store`, every run writes two records through the agent's write queue before `done` is emitted:

- `runs/<runId>`: the run record. It holds `schemaVersion` (currently `RUN_RECORD_SCHEMA_VERSION`, 1), `runId`, `responseId`, `agentName`, `instanceId`, `mode` (`'task'`), `agentVersion` and `version`, `label`, `scope` (stored untouched), `model`, the settings as sent (see [Agent versions](#agent-versions)), `unattended`, `status` and `usage`. It also holds `timings` (`startedAt`, `firstTokenMs`, `durationMs`, `modelMs` streaming time without queueing, `toolMs` summed over top-level calls, `queuedMs` waiting for the scheduler), `stepCount`, `failureCount`, and, when content capture is on, the `task` text and final `answer`.
- `traces/<runId>`: the same identity fields plus `steps`, one per tool call in start order. A step has `index`, `turn`, `callId`, `parentCallId` (inner `aigent_multi` calls), `tool`, `argsSummary` (the first 120 characters of the arguments' canonical JSON), `args` (content capture only), `ok`, `errorCategory` / `errorCode`, `itemFailures` / `itemTotal` for batch calls, `resultBytes` and `resultTokens` (estimated as characters / 4) of the full result, `truncated`, `durationMs`, `startedAtMs`, and `cacheHit` / `savedMs` for cacheable tools (see [Tool-result cache](#tool-result-cache)). Refused calls (unknown tool, invalid arguments, over `maxToolCalls`) are steps too, so every failure is recorded.

Each step may also carry the agent's `outcome` (`{ success, answer, source }`, see [Agent feedback](#agent-feedback-enablefeedback)), and the run record sums them in `outcomeSummary` (`claimedSuccess`, `claimedFailure`).

Every record carries `schemaVersion`, `runId`, `agentName`, `instanceId`, `mode`, `agentVersion`, `scope` and `recordedAt`. `TaskResult.responseId` and the `done` event identify the answer for [user feedback](#user-feedback-on-responses).

```ts
const ai = createAigent({
  providers, store,
  redact: ({ collection, key, value }) => ({ collection, key, value: scrubEmails(value) }),
  captureContent: true,                       // default; false keeps metrics and argument shapes only
  retention: { expiresInMs: 30 * 24 * 3_600_000 },
});

const trace = await ai.trace(result.runId);   // { run, steps } or undefined
await ai.purge({ agentName: 'writer', before: Date.now() - 7 * 24 * 3_600_000 });
```

- **`redact(record)`** runs on a copy of every record of every collection before it reaches the store (`runs`, `traces`, `feedback` and the `responses` index), including `settings.providerOptions` and each `fallbacks[].settings.providerOptions`. It may change `value` only. If it throws or changes the collection or key, that record is not written and the run emits a warning.
- **`captureContent: false`** stores no task text, answer, argument values, outcome answers or feedback text. `argsSummary` then shows only the arguments' shape, for example `{"path":"<string>"}`. Every step also gets `argsHash`, an HMAC-SHA-256 of the full arguments salted with the run id: it reveals no content, and repeat and waste detection compare it (not the summary), so `a.txt` and `b.txt` are not repeats. `aigent_feedback` entries keep `kind`, `relatedTool` and `textLength`; `ai.feedback` keeps the rating with `commentLength` and `expectedAnswerLength`.
- **`retention.expiresInMs`** stamps `expiresAt = recordedAt + expiresInMs` on every record; the store decides whether to honour it.
- **`ai.purge(filter)`** deletes records matching every given field of `{ agentName?, runId?, before? }` (`before` compares `recordedAt`) through the optional `Store.purge` and resolves with the count. It rejects with `invalid_input` for an empty filter, without a store, or when the store has no `purge`. The in-memory store implements it.
- **`ai.trace(runId)`** returns the stored run and its steps, validated against the schema, or `undefined`.
- **Failures never fail the run.** A store or `redact` failure becomes one `warning` (`Could not save run record: …`) naming each record that was not written. The queue is not blocked, so later writes still succeed.
- **`disableTelemetry: true`** on a task writes nothing at all (events still stream), so evaluation runs never reach scores.

Traces can contain sensitive content (task text, answers, tool arguments). Content is stored by default because analysis needs it; use `redact`, `captureContent: false`, retention and `purge` to control it.

### Large tool results

A tool may declare `maxResultTokens`. When its serialised result is larger, the model sees `{ truncated: true, note: 'Result truncated to ~N tokens (was ~M); narrow the request or page through it.', preview }` instead, where `preview` is the first N tokens' worth of the JSON text. The step records `truncated: true` and the original size. Failed results are never truncated, and failures inside a truncated batch result still reach `TaskResult.errors`.

## Tool-result cache

Results of tools declared `cache: true` are cached, so a repeated call is served without running the tool again. It is on by default; `createAigent({ cache: false })` turns it off and `cache: { maxEntries, maxBytes, maxEntryBytes }` sets its limits (defaults 1,000 entries, 64 MiB, 256 KiB per result; each must be a positive integer, otherwise `invalid_definition`).

```ts
const readFile = defineTool({
  name: 'read_file', description: 'Read a file', args: z.object({ path: z.string() }).strict(),
  deterministic: true, cache: true,
  version: '2',                                          // bump to invalidate old results
  cacheKey: ({ path }) => ({ path: normalisePath(path) }), // what identifies a call (default: the arguments)
  validity: async ({ path }) => { const { mtimeMs, size } = await stat(path); return `${mtimeMs}:${size}`; },
  describeActivity: ({ path }) => ({ title: `Reading ${path}` }),
  run: async ({ path }) => readFile(path, 'utf8'),
});
```

- **Key:** a sha-256 of the canonical JSON of the tool name, its `version`, a hash of its argument schema and the normalised arguments. Argument key order never matters, `previous` and alias tokens are removed or expanded before the key is computed, and a changed schema or version never collides with older entries.
- **Scope:** results of `deterministic` tools are shared by every agent and instance using the store (namespace `global`). A cached non-deterministic tool must declare `cacheTtlMs`, and its results stay private to the agent instance that produced them (`instance:<instanceId>`). Entries expire after `cacheTtlMs` when it is set, measured with the injected clock.
- **Validity:** when a tool defines `validity`, the token is computed before every lookup and stored with the entry. An entry whose token changed is never served: the call runs again, replaces the entry and counts as an invalidation. A `validity` or `cacheKey` that throws makes that call run uncached.
- **Never cached:** failed calls (including timeouts and aborts), results larger than `maxEntryBytes`, and tools with side effects.
- **Copies:** results are deep-copied when stored and when served, so mutating a result never changes a later hit. The cache holds the full result; `maxResultTokens` truncation applies to each served copy.
- **Single-flight:** identical calls that arrive while the first is still running wait for it and are then served from the cache, so the tool runs once. If the first call fails, the waiting calls run themselves.
- **Eviction:** beyond `maxEntries` or `maxBytes` of live entries, the least recently requested entries are evicted. An evicted entry keeps its statistics (its value is dropped), so findings still see its history.
- **Storage:** entries live in the runtime `store`, collection `toolcache`, keyed `${namespace}:${key}`, as `{ schemaVersion, namespace, tool, storedAt, expiresAt?, validity?, value, bytes, originalDurationMs, resultTokens, evicted?, stats }`. `stats` holds `firstStoredBy`, `totalHits`, `hitsByAgent`, `missesByAgent`, `lastRequestedAt`, `missCount`, `invalidationCount`, `savedMs` and `savedTokens`, all updated through the keyed write queue so they are exact under concurrency. Without a store, or with `captureContent: false`, entries go to a private in-memory store instead, so tool results never reach a store whose owner asked for no content. Cache entries do not pass through `redact` (it could alter what is served back) and are not removed by `purge`.
- **Telemetry:** a hit is still a normal tool call: the model receives the usual envelope, activity views are emitted and `usage.toolCalls` counts it. Its trace step has `cacheHit: true` and `savedMs` (the original call's duration); steps of cacheable tools that missed have `cacheHit: false`.
- **Findings:** `report.cache` holds `hottest` (the 10 entries with most hits, with `savedMs`), `hitRateByTool` and `hitRateByAgent` (hits / lookups), `frequentlyInvalidated` (tools with at least 3 invalidations making up a quarter of their lookups) and `worthMarkingDeterministic`: uncached tools called 3 or more times with identical arguments within one run, in at least 2 of the report's runs.

## User feedback on responses

Every result carries a stable `responseId` (also on the `done` event). Rate the answer, now or much later, from any runtime on the same store:

```ts
await ai.feedback({ responseId: result.responseId, rating: 'incorrect', comment: 'Wrong file', expectedAnswer: 'src/ThemeProvider.tsx' });
await result.feedback({ rating: 'correct' });   // the same, with the responseId filled in
```

- `rating` is `'correct'`, `'incorrect'` or `'partial'`; `comment` is at most 2,000 characters and `expectedAnswer` at most 10,000. Invalid input rejects with `invalid_input` naming each field.
- Each stored run writes an index entry, `responses/<responseId>`, that finds its run. An unknown id rejects with `invalid_input` naming it; that includes `disableTelemetry` runs, runs made without a store and purged runs.
- The rating is stored in `feedback/<responseId>` as `{ kind: 'user', responseId, rating, comment?, expectedAnswer?, history }` plus the run identity. Rating again amends it: the latest rating wins and `history` keeps every rating (`{ at, rating, comment? }`). Concurrent ratings never lose history.
- The run record gets `userVerdict` (the latest rating), so scoring reads it without a join. The user's verdict counts over the agent's own success claims.
- Writes go through `redact` and the agent's write queue like every other record.
- `result.feedback` is not enumerable, so results stay plain data.

## Agent feedback (`enableFeedback`)

`enableFeedback` asks the agent to report how its work went. It is set per agent (`ai.agent({ enableFeedback })`), with `createAigent({ enableFeedback })` as the default for agents that leave it out. When neither is set it is on, except when `NODE_ENV` is `production`. When on:

- **`previous`:** every tool call (and `aigent_multi`, at its top level only) gets a `previous` field, `{ success, answer }` (answer at most 300 characters), saying how the previous tool step went. It is nullable, so the first call sends `null`. The loop takes it out of the arguments before they are validated, run, cached, recorded or shown in the `tool-call` event, and attaches it to the last top-level step of an earlier turn (the results the model has seen; parallel siblings in the call's own turn are never targets). The first `previous` on a step wins. A `previous` inside `aigent_multi` inner calls is stripped and ignored with a warning. A tool may not declare its own `previous` argument while feedback is on (`invalid_definition`). A later call that leaves it out still runs; the run emits one `warning` per run. An invalid `previous` is ignored with a warning.
- **`::aigent outcome`** directives do the same from the text stream and attach to the same step (the last top-level step of an earlier turn), even when they arrive after the turn's own tool calls. When a directive and `previous` report the same step, the directive wins and one outcome is stored (`source: 'directive' | 'previous'`).
- **`aigent_feedback`:** a built-in strict tool taking `{ entries: [{ kind: 'easy' | 'hard' | 'suggestion' | 'missing' | 'simplify', text (1 to 500 characters), relatedTool? }] }` (1 to 10 entries). Each entry is stored in the `feedback` collection as `{ kind: 'agent', callId, index, entry }` plus the run identity, keyed `${runId}:${callId}:${index}`, with the run's other records. It is commentary, not work: it never counts against `maxToolCalls` or toward `usage.toolCalls`.
- **The system prompt** gains a short fixed addendum describing the three, as part of the stable prefix.

When off, requests contain none of these (no tool, no field, no directive instructions), so it adds zero tokens. The resolved flag is part of `agentVersion`. Without outcomes (the production default), scoring and request analysis fall back to timings, tokens, errors and user feedback.

## Scoring and `ai.report()`

`ai.report(filter?)` turns the stored runs into scores and findings, with no model calls:

```ts
const ai = createAigent({ providers, store, pricing: { 'anthropic:claude-sonnet-5-5': { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cachedInputPerMTokUsd: 0.3 } } });
const report = await ai.report({ agentName: 'writer', since: Date.now() - 86_400_000, compareVersions: ['v1', 'v2'] });
```

- **Filter:** `agentName`, `instanceId`, `agentVersion` (hash or `version` label), `since` (start time), `label`, `unattended`, `includeDisabled` (only `false`: `disableTelemetry` runs are never stored), `compareVersions: [before, after]` and `minRuns` (default 5). An invalid filter rejects with `invalid_input`. Without a store the report is empty. Stored records that do not match the schema are left out.
- **Scores** (`report.agents[]`, one per agent name and version): `speed`, `tokenEfficiency` (cached input weighted 0.1), `turnEfficiency` (tool calls per turn and turn count), `toolEfficiency` (batch items per call and calls that are not repeats), `cost` (needs `pricing`, keyed `provider:model`) and `reliability`. Each is `{ value, label, evidence }`.
- **Baselines:** a score is relative to the agent version's own rolling baseline. Each run is compared with the median of the up to 50 runs of that version before it, and the per-run scores are averaged. Runs outside the filter still count as history. 50 means "as usual" and 100 "twice as good or better". A run with fewer than `minRuns` earlier runs is not scored; with none scored, the value is null and the label `insufficient-data`. Labels are `fast` / `slow` for speed and `efficient` / `inefficient` otherwise (60 and above, 40 and below), with `average` in between.
- **Reliability** is the percentage of scored runs that completed with no more tool failures than their baseline's median. The user's verdict overrides it: a run rated `incorrect` is never reliable, even if the agent claimed success, and one rated `correct` always is. Labels: `efficient` at 90 or more, `inefficient` below 70.
- Each agent entry also has `totals`, `medians` and `p90s` (duration, tokens, turns, tool calls, tool calls per turn, cost).
- **Findings** (`report.findings`) are sorted by severity (`bad`, `warn`, `info`) then id, and each carries its evidence:

  | Kind | When |
  | --- | --- |
  | `slow-tool` | a tool's median call takes 2 s or more and 3 times the agent's typical call |
  | `failing-tool` | a quarter of a tool's calls fail (`bad` at half) |
  | `verbose-tool` | a tool's median result is 2,000 tokens or more |
  | `truncation-frequent` | a quarter of a tool's results were truncated |
  | `unbatched-repeats` | one run calls a tool 3 or more times with the same argument keys, in separate calls |
  | `too-many-turns` | a run takes 5 or more turns at 1.5 tool calls per turn or fewer |
  | `high-retry-rate` | an agent retries provider calls on a fifth of its turns or more |
  | `claimed-success-user-incorrect` | the agent reported success but the user rated the answer incorrect |
  | `slow-run`, `expensive-run` | a run takes 3 times the agent's median duration or cost (tokens without pricing) |

  `guardrail` is reserved for the guardrails slice. Cache findings are in `report.cache` (see [Tool-result cache](#tool-result-cache)).
- **`compareVersions`** gives `comparison.before` and `comparison.after` (runs, and medians of duration, tokens, turns, tool calls per turn, cost and reliability) and their `deltas` (after minus before). Values are null where a side has no data.

### Request analysis and tool suggestions

The report also looks at what was asked, across runs, without any model calls:

- **`report.requests`** groups runs with similar tasks. Task text is lowercased, punctuation and stopwords are removed, numbers become `#`, and runs are clustered by token-set Jaccard similarity of at least 0.6 to the group's first task. Runs without stored task text (`captureContent: false`) group by `label`, or stand alone. For each group it gives `runs`, `successfulRuns`, `typical` (median tokens, turns and tool calls), `cheapestSuccessful` (`runId`, tokens, turns, tool calls, duration and the tool `path`), `potentialSaving` (typical minus cheapest), and `wastedSteps`. A run is successful when the agent's last reported outcome was a success and no user rated it incorrect, or when a user rated it correct; runs rated incorrect are never the cheapest path. A wasted step is `{ runId, stepIndex, reason }`, where the reason is one of:
  - `failed-before-success`: the call failed and a later call to the same tool succeeded.
  - `repeat-call`: the same call already succeeded earlier.
  - `superseded-search`: a search-like call that a later search replaced.
  - `unbatched`: the same tool with the same argument keys, called back to back a turn apart.
- **`report.toolSuggestions`** mines recurring contiguous tool sequences (2 to 5 calls, in at least 3 distinct runs) that end in a step the agent reported as a success. Sequences wholly inside one `aigent_multi` batch and runs rated incorrect are ignored, and a sequence is only kept in its longest form. Each suggestion has a snake_case `name` from its tools (for example `search_then_read`), a `description`, the sequences it `replaces`, `supportingRunIds`, `proposedArgs` (the argument names and types its first call took) and `estimatedSaving` per use. The saving counts the intermediate result tokens, the extra turns and the time before the last call.
- **`report.agentFeedback`** summarises what each agent said through `aigent_feedback` on the report's runs: `total`, counts `byKind`, counts `byTool` (`relatedTool`, each with its own kinds) and the `recent` texts, newest first, at most 10. With `captureContent: false` no text is stored, so entries are counted but never quoted.

Both depend on outcomes: with `enableFeedback` off they rely on user verdicts alone.

## Stream directives

The model may emit single-line directives anywhere in its reply, each on its own line starting with `::aigent`. The system prompt only describes them when [feedback](#agent-feedback-enablefeedback) is on, but they are always parsed as the tokens arrive (chunk-boundary safe), removed from the visible `text-delta` stream and published as `directive` events:

```text
::aigent status {"text":"Checking the theme folder"}
::aigent outcome {"success":true,"answer":"short result of the previous step"}
```

Malformed or unknown directives produce a `warning` event and never abort the stream.

## Status

Phase 1 foundation core, implemented in this slice:

- `createAigent` and named agents, `agent.task()` with streaming events, stop modes and limits
- Strict tool API (`defineTool`, `defineBatchTool`), structured per-call result envelopes, the built-in `aigent_multi` tool and tool activity rendering
- Keyed per-agent write queue and the `Store` contract with an in-memory store, plus `updateRecord` (compare-and-set read-modify-write with jittered backoff; throws `store_conflict` after `maxAttempts`, default 50)
- Stream directive parser, task input validation, system prompt and task brief
- `FakeProvider` test helpers (`@anupheaus/aigent/testing`, no test-runner dependency)
- `describeProviderContract`, the vitest suite every provider must pass (`@anupheaus/aigent/testing/contract`; needs `vitest`, an optional peer dependency)
- Streaming provider adapters: `anthropic` and `openAiCompatible`, with the `deepseek`, `openai` and `ollama` presets
- Model settings resolved task > agent > runtime > provider and mapped per provider, and the agent version hash
- Provider retry with backoff and `retry-after`, first-event timeout and fallback models
- A shared scheduler (`createScheduler`): concurrency and per-minute limits, priority lanes, per-agent fairness and 429 adaptation
- Versioned run records and step traces with tool telemetry, the `redact` hook, content capture, retention hints, `ai.trace` and `ai.purge`
- `enableFeedback`: the `previous` outcome field, `::aigent outcome` linking and the `aigent_feedback` tool
- User feedback on responses: `ai.feedback` / `result.feedback`, with amendable history and `userVerdict` on the run record
- Scoring against rolling per-version baselines, findings, version comparison and `ai.report()`
- Request analysis (similar-task groups, cheapest successful path, wasted steps) and tool suggestions from mined sequences
- Tool-result cache with global and per-instance scopes, validity tokens, TTL, single-flight, LRU eviction and per-entry statistics

Roadmap (later slices, each with its own spec): vision, chat sessions, context compaction and layout, built-in tool packs (filesystem, code intelligence, web and more), an optimisation phase, then learning (memory first, then prompt/strategy tuning and reusable skills), plus resume, guardrails and approvals.

## License

MIT
