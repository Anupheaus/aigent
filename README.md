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
| `thinking-done` | a model turn's streamed reasoning ended (its whole text) |
| `text-retracted` | the text the last model turn streamed (`text`) is withdrawn: sent back for `output_invalid` (no `replacement`), or changed by the output guardrails (`replacement` is the answer); chat replaces the reply's text |
| `activity` | what the agent is doing now (see [Activity updates](#activity-updates)); the terminal update comes just before `done` |
| `tool-call`, `tool-activity`, `tool-result` | a tool call, its activity rows and its result envelope |
| `plan-update`, `todo-update` | the plan or the todo list changed (see [Plan and todo](#plan-and-todo)) |
| `directive` | a parsed `::aigent` directive |
| `usage` | token usage reported by the provider for a turn |
| `queued` | a provider call is waiting for the scheduler |
| `retry` | a provider call failed before its first event and will be retried |
| `fallback` | a turn moved to the next fallback model |
| `planned-effects` | dry runs: what a call would have done (see [Dry runs](#dry-runs)) |
| `guardrail` | a guardrail rewrote, blocked or warned about something, or its check failed (see [Guardrails](#guardrails)) |
| `approval-request`, `approval-decision` | a call waits for a person's approval, and how it was decided (see [Human approvals](#human-approvals)) |
| `delegated` | an event of a sub-run started by a `delegate` call (see [Agents and delegation](#agents-and-delegation-anupheausaigenttoolsmeta)) |
| `warning` | something was ignored or cut short, such as an unsupported setting or a malformed directive |
| `error` | the run failed |
| `done` | the final status and the answer's `responseId`, after the run's records are written |

## Stopping a run

```ts
run.stop({ mode: 'graceful' }); // finish the current turn, then stop (status 'stopped')
run.stop();                      // immediate (default): abort now (status 'cancelled')
run.cancel();                    // alias for stop({ mode: 'immediate' })
```

An immediate stop aborts the stream and read-only tools at once; tools with side effects (`hasSideEffects: true`) are allowed to finish (bounded by their own `timeoutMs`) so a write is never left half-done, unless you pass `force: true` (`run.stop({ force: true })`). Reaching `timeoutMs` aborts everything.

`run.steer(text)` delivers `text` as a user message at the run's next safe boundary (after the in-flight tool results, before the next model request), with no extra request. Text that arrives after the last model request is not delivered, and a `warning` says so.

Repeated calls, and calls after the run has settled, are no-ops. A task can also take `limits` (`maxTurns`, `maxToolCalls`, `timeoutMs`) and an `AbortSignal`. Reaching `maxTurns` or `timeoutMs` ends the run with status `limit_reached`. `maxToolCalls` does not end the run: calls past it (including calls inside `aigent_multi`, which each count) are refused with a `tool_call_limit` envelope the model can see, and the run continues.

## Activity updates

Both `agent.task()` and chat turns emit the same `activity` events: an `ActivityUpdate` with `seq` (gapless per run), `runId`, `messageId` (chat), `phase` (`queued`, `planning`, `thinking`, `calling_tools`, `waiting_for_user`, `writing`, `finishing`, then `done`, `failed` or `cancelled`; `recalling` and `verifying` are reserved), `statusText` (derived, such as "Running 3 tools" or a single tool's activity title, or the agent's own `::aigent status` text), `current` (tools in flight with batch progress), `progress` (plan, todo, criteria, turn of `maxTurns`), `elapsedMs`, `tokens`, `costUsd` (with `pricing`) and `heartbeat`.

Updates are derived from the loop's events, so they cost no model call. They are throttled to one per `throttleMs` (default 250; the terminal update is never held back), with a heartbeat every `heartbeatMs` (default 5000) while the agent is busy (not while it waits for the user): `createAigent({ activity: { throttleMs, heartbeatMs } })`.

Runs (and chat turns) also offer callbacks that see exactly the events, earlier ones included: `run.onActivity(update => ...)`, `run.onToolActivity(event => ...)` and `run.onThinking((thinking, { runId, turn, messageId, provider, model }) => ...)`, which is called once per model turn that streams reasoning, with an async iterable of its deltas. `onThinking` gets the reasoning even with `showThinking: false`, which only hides it from the event stream and the chat message. Each returns an unsubscribe function.

## Chat

`agent.chat(options?)` is a stateful conversation. Each `send` runs one agent reply through the same loop as `agent.task()` (tools, plan and todo, compaction, and run records with `mode: 'chat'`), over the session's history:

```ts
const chat = agent.chat({ context: 'You help with the billing app' });
const turn = chat.send('Where is the invoice total computed?');
for await (const event of turn) if (event.type === 'text-delta') process.stdout.write(event.text);
const reply = await turn; // { text, responseId, messageId, usage, status, feedback() }
await chat.close();
```

Options: `sessionId` (reopen a stored session), `persistence` (`'store'` by default when the runtime has a store, else `'memory'`, which writes nothing of the session to the store: no chat records, and its turns write no run records, traces, checkpoints or tool-cache entries), `context` and `constraints` (the session brief; `chat.setContext(text)` changes it for later turns), `unattended`, `signal`, `modelSettings`, `whileBusy` (default delivery, `'queue'`), `coalesce`, `onStop`, `autoTitle` and `attachments`. Sessions of one agent never see each other's messages.

### Conversation model

`chat.conversation()` returns the whole UI-ready state as plain JSON: `messages` (each with `id`, `seq`, `role`, `kind`, `parts`, `replyTo`, `threadId`, `branchId`, `state`, `delivery`, `pinned`, `compactable` and `meta`), `threads`, `branches`, `pinned`, `openQuestions`, `queue`, `plan`, `todo`, `activity`, `usage`, `status` and `seq`. An agent reply streams into one message (`message-updated` deltas on its first text part); each model request's tool calls form one collapsible `tool_activity` message. A reply's `meta` holds the same figures as its run record (`runId`, `responseId`, provider and model, tokens, `costUsd` with `pricing`, timing, tool calls, cache hits), plus `meta.history`: exactly what the model saw for it.

`chat.subscribe(listener, { fromSeq })` delivers the same changes as patches (`message-added`, `message-updated`, `message-interrupted`, `thread-updated`, `branch-created`, `branch-selected`, `question-opened`, `question-answered`, `plan-updated`, `todo-updated`, `status-changed`, `usage-updated`, `activity-updated`, `queue-updated`, `title-updated`, `pinned-updated`, `session-forked`; `message-removed` is for UI-local drafts only). Every patch carries a gapless `seq`; `fromSeq` replays the recorded patches from that seq first, so a UI reconnects with `{ fromSeq: state.seq + 1 }`. Folding the patches with the exported `reduceConversation(state, patch)` from `createEmptyConversation({ sessionId, agentName })` always gives `chat.conversation()`; the reducer ignores patches it already applied and throws `invalid_input` on a gap. `createConversationStore(initial?)` wraps it for React's `useSyncExternalStore` (`getSnapshot`, `subscribe`, `dispatch`).

With `persistence: 'store'` every patch goes through the keyed write queue (key `chat:<agentName>:<sessionId>`) and `redact` into collection `chats`: one session record (with a snapshot every 100 patches and on close) and the patches in chunks of 100. `agent.chat({ sessionId })` reopens the identical conversation (`await chat.ready` before reading it; methods wait on their own). A reply that was still streaming when the session was last written comes back as `cancelled`. `chat.close()` lets the running turn finish and flushes the writes; `ai.close()` closes open chats first. A turn that waits for an answer, or asks once close has begun, is cancelled with its questions kept open; queued messages are settled `cancelled`; after close, `send` fails its turn and `answer`, `edit`, `regenerate` and `fork` are refused. If a chat write fails, nothing later is written (so the store never holds a hole or a snapshot ahead of its patches) and `close()` (and `ai.close()`, after closing everything) rejects with `store_failed` naming the session and the unstored seqs; a stored history with a hole fails to load with `store_failed` rather than replaying a broken stream. One stored session can be open once per runtime: a second `agent.chat({ sessionId })` before the first is closed throws `invalid_input`.

### Delivery while the agent is busy

The user can always send. `send(input, { delivery })` (default: the chat's `whileBusy`, `'queue'`):

- `queue`: the message waits in `conversation().queue` and runs as its own turn afterwards, in order. `chat.queue()` lists it; `chat.queue.edit(id, text)`, `move(id, toIndex)` and `remove(id)` work until it starts (then they throw `invalid_input`). With `coalesce` (per message or per chat), adjacent queued messages that ask for it are answered in one turn.
- `steer`: delivered inside the running turn at its next safe boundary (after the in-flight tool results, before the next model request) as a user message with `delivery.steered`, with no extra model request. A steer that arrives after the turn's last request is queued instead.
- `interrupt`: the running reply stops now. Its partial text is kept with state `cancelled` (patch `message-interrupted`), read-only tools are aborted, side-effecting tools finish unless `force: true`, completed tool results are kept, and any tool call left without a result gets a synthetic `aborted` result so the next request is provider-valid. Then the new message starts a fresh turn.

`turn.stop({ mode: 'graceful' | 'immediate', force })` and `turn.cancel()` work as for tasks; stopping a turn that has not started removes it from the queue. `onStop: 'discard'` drops the queued and steering messages that were waiting when a turn is stopped through its handle (a message sent after the stop still runs; default `'keep'`). Behaviour change for tasks and chats alike: an `immediate` stop now lets in-flight side-effecting tools finish unless `force: true`.

### Questions (`ask_user`)

In chat (unless `unattended`) the agent has the `ask_user` tool: a batch of 1 to 10 questions of type `text`, `number`, `confirm`, `single_choice` or `multi_choice` (choices need 2 to 20 options), each with `required` and optional `default`, `min` and `max`. The turn then waits inside the tool, making no model request and spending no tokens, with status `waiting_for_user`; each question appears as a `question` message and in `openQuestions`. `chat.answer(questionId, value)` validates the answer (an invalid one stays open and the result says precisely why) and adds an `answer` message; question and answer messages link both ways and are never compacted. Once every required question of the batch is answered, the model gets one result per question and the turn resumes. While exactly one question on the selected branch is open, a plain `send(text)` (no delivery, thread or attachments) that is a valid answer answers it. When a batch completes, its unanswered optional questions are closed as skipped (a `(skipped)` answer message, `questionMeta.skipped`), so none outlives its turn. A question the model cannot validly ask (min above max, a default that is not a valid answer, options whose values or labels collide, a comma in a multi-choice option, min/max on a type that ignores them) is refused with `invalid_args`.

Stopping or closing a waiting turn cancels it and leaves its questions open. They are stored with the session, so they survive a reopen. With `createAigent({ resume })` answering them continues the suspended turn itself, even in a new process: the same model turn gets the answers as its `ask_user` result, from its checkpoint (see "Resuming agent instances"). Without `resume`, answering starts a fresh turn that sees the answers as user text; `chat.answer` then returns it as `{ ok: true, turn }`. Either way the turn runs where the question was asked (in its thread, if any); a question on a branch that is not selected is answered only after `chat.selectBranch` to it. Without a user (`unattended`, or a task without `onQuestion`) a call to `ask_user` is refused with a `denied` result, so the ambiguity policy applies. In task mode, `agent.task({ ..., onQuestion: async questions => ({ [id]: value }) })` answers each batch.

### Threads, branches and forks

- `send(text, { replyTo })` opens (or continues) a thread on that message. A thread turn sees only a short extract of the main line's last six messages, the root message and the thread's replies; the main line never sees the thread. `chat.thread(messageId)` lists it, and `thread.promote()` adds a summary message (kind `summary`) to the main line.
- `chat.edit(messageId, newText)` and `chat.regenerate(messageId)` start a new branch from just before that message (only while idle). Nothing is deleted: `chat.branches()` lists the tree, `chat.selectBranch(id)` switches back, and the model only ever sees the active branch's lineage.
- `chat.fork({ atMessageId })` returns a new session with this one's main line up to that message (`conversation().fork` records the parent and fork point); the two evolve independently.

### Attachments, pins, reactions and titles

`send({ text, attachments: [{ kind: 'file' | 'image', ref | bytes | text, name, mimeType }] })`: refs are read through `attachments.readAttachment(ref)` (the core never touches the filesystem). Contents are stored by content hash in collection `attachments` (identical content once). Text files up to 8 KiB are inlined into what the model sees; anything larger is referenced by handle with a one-line summary. Images need a model with `capabilities.vision` (otherwise `invalid_input`, or the text from `attachments.describe` with `onNoVision: 'describe'`); provider image parts arrive with a later slice, so an image currently reaches the model as a handle line.

`chat.pin(id)` / `unpin(id)` keep a message verbatim through compaction. `chat.react(messageId, 'up' | 'down', comment?)` records `ai.feedback` (`correct` / `incorrect`) on that reply's `responseId` and notes `userRating` in its meta; `chat.feedback(f)` rates the latest reply. `autoTitle: true` makes one cheap call after the first exchange to name the session; its tokens are counted apart in `usage.title`. The call is a background request (scheduler lease, retry and fallback like any turn), only one is in flight, it is given up after 30 s, and `close()` aborts it rather than waiting (the session then stays untitled until a later reply).

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

## Volatile block and prompt-prefix stability

Providers cache a prompt's prefix, so everything that changes from turn to turn goes **last**. Every request ends with one `user` message, the volatile block, built fresh for that request and never stored in the history or compacted:

```text
# Current state (generated by the runtime, not written by the user)
Date and time: 2026-10-20 14:37 (UTC)
Locale: en-GB
Progress: turn 2 of 25; 3 of 100 tool calls used

## Plan status
...
```

The order is fixed: date and time, locale, progress counters, then extra sections (plan statuses, the todo list, corrections). Everything before it (system prompt, task brief, pinned plan definitions, the turns so far, and the tool specs sorted by name) stays byte-stable across turns. The heading says the block comes from the runtime, so the model does not read it (or its corrections) as the user's words.

The block is marked `volatile: true` on the request's `ProviderMessage`. With prompt caching on, the Anthropic adapter puts ephemeral cache breakpoints on the system prompt (which also covers the tool definitions, since tools come before the system prompt in Anthropic's cache order) and on the last block of the stored history right before the volatile block (for a tool turn, the last tool result, ahead of the volatile text merged into the same user message). Each turn therefore reads tools, system and every earlier turn from the cache and writes only the new turn. Requests without a volatile block (direct adapter use) get the system breakpoint only. The OpenAI-compatible adapters rely on the providers' automatic prefix caching and ignore the flag.

```ts
createAigent({ providers, volatile: { dateTime: { granularity: 'hour' }, timezone: 'Europe/London', locale: 'en-GB' } });
```

- `dateTime`: `{ granularity: 'minute' | 'hour' | 'day' }` (default minute; the time is rounded down in `timezone`), or `false` to leave it out.
- `timezone`: an IANA name (default `UTC`); `locale` is named in the block when set. An unknown timezone or option fails with `invalid_definition`.
- `progress: false` leaves the turn and tool-call counters out. With no date, no progress and no sections, no block is sent.
- **Prefix monitor:** each run checks that each request's history starts with the previous request's history unchanged. If an earlier message (or a tool spec) changes without a deliberate rewrite (the pinned plan block) or a compaction, the run emits one `warning` per run: "Prompt prefix changed between turns without a compaction; ...". It is on unless `NODE_ENV` is `production`; `volatile.warnOnPrefixChange` turns it on or off explicitly.

## Context layout

A run stores its history as context messages: the provider message plus a `kind` (`system`, `brief`, `user`, `assistant`, `tool`, `question`, `answer`, `summary`, `pinned`, `directive`, `stub`), a `compactable` flag, a `pinned` flag, a token estimate and, for a tool round, a `pairId` (the first call's id) shared by the assistant message and all of its results.

- **Never compacted:** `system`, `brief`, `question`, `answer`, `summary`, `pinned` and `directive` messages, and any message the user pins. `user`, `assistant`, `tool` and `stub` messages are compactable. A tool can keep its results out of compaction with `defineTool({ compactable: false })` (part of the agent version).
- **Layout:** `[system][non-compactable][summary][recent + new][volatile]`. Between compactions the history is append-only, so each request's prefix is byte-identical to the previous request's plus the new tail. Only a compaction reorders it, by hoisting every non-compactable message (in their original order) ahead of the single summary.
- **Cache breakpoints:** each request carries `cacheBreakpoints`, the indices of the last system message, the end of the non-compactable block, the summary and (with a volatile block) the last stable message. With prompt caching on, the Anthropic adapter puts `cache_control` on the last block of each of those messages, up to three plus the system block's (four in all, the API limit; the latest are kept). OpenAI-compatible adapters ignore them, as those providers cache prefixes automatically.
- **Budget:** the context size is `modelSettings.contextSize`, else the provider's `maxContextTokens`; the usable prompt budget is that (the smallest window of the agent's models, fallbacks included) minus `maxOutputTokens` (when unset, 4,096 or a quarter of the window, whichever is smaller). Prompt size is estimated as characters / 4 plus 4 tokens per message plus the tool specs, and calibrated by the ratio of the provider-reported `inputTokens` to the estimate (clamped to 0.5–2). `TaskResult.usage.contextTokensPeak` is the largest prompt the run sent.

## Compaction

Long runs stay inside the window by compacting their history under token pressure, never by turn count:

```ts
ai.agent({
  name: 'researcher', model: 'anthropic:claude-sonnet-5-5',
  modelSettings: { contextSize: 64_000 },
  compaction: { compactAt: 0.75, compactTo: 0.45, keepRecent: 4, minSavingTokens: 500, minTurnsBetween: 3 }, // the defaults
  compactionModel: 'ollama:qwen3:8b', // optional: who writes summaries (default: the agent's own model and fallbacks)
});
```

- **When:** before each request, at a turn boundary (every result of the previous round stored, so compaction never runs mid tool round), when the calibrated estimate reaches `compactAt` of the usable budget. It then works down to `compactTo`, so with the defaults a compaction frees at least 30% of the budget. When the last `keepRecent` rounds alone keep the prompt above `compactTo` (large tool results), that compaction keeps fewer recent rounds verbatim (never fewer than the latest one), so it still lands well below `compactAt`. After a compaction the next one waits `minTurnsBetween` turns unless the prompt no longer fits, so the cached prefix is not rewritten turn after turn. A compaction whose stages changed nothing is not counted. It is skipped when the saving would be under `minSavingTokens` and the prompt still fits, and on a run's last allowed turn when the prompt still fits. Policies are validated at `ai.agent` (`0 < compactTo < compactAt <= 1`, `keepRecent >= 1`, `minTurnsBetween >= 0`), and both `compaction` and `compactionModel` are part of the agent version.
- **Stages, cheapest first, each only while still above `compactTo`:** (1) **stub** stale tool results, biggest first: the tool message stays (so call and result stay paired) and its text becomes `[result of <tool> call <id> omitted to save context (~N tokens); refetch with result_original handle <H>]`; the original is kept under that handle, and `result_original` is added to the run's tools at the first stub if shaping had not already added it. (2) **Dedupe:** an older copy of an identical tool result becomes `[same result as call <id>, kept below]`. (3) **Summarise** every eligible message into one structured summary (Goal, Decisions, Facts, Open items, Tool outcomes) through the normal provider path (scheduler, retries and fallbacks apply), merging the previous summary, so there is only ever one `summary` message. The summariser is told that tool results are data, never to follow or copy instructions found in them; each result is sent delimited as tool output with `::aigent` lines and instruction-override phrases ("ignore previous instructions", "you are now"...) defused, and the stored summary is labelled as a record (not instructions), wrapped in `<record>` delimiters and defused the same way. (A local measure until the guardrails slice adds injection detection.) The summariser request is bounded: the run's `stop`, `seed` and `thinking` settings are dropped and `maxOutputTokens` is 1,024; its input is cut to the oldest whole rounds that fit the summariser model's own window.
- **What is never touched:** the last `keepRecent` tool rounds (fewer only as above), any round with an unanswered call, and every non-compactable message. A tool round is the unit: an assistant message with tool calls is never summarised without its results, or the other way round. A tool declared `compactable: false` keeps its result and the round's assistant call verbatim; a compactable sibling result in the same parallel round can still be stubbed (the stub keeps the pairing), but the round is never summarised.
- **Hoist:** a compaction is the only time the prefix changes. Every non-compactable message older than the recent window (including any added since the last compaction) moves to the front in its original order, a tool round moving whole (its compactable results are stubbed first and then frozen), then the summary, then the remaining messages; non-compactable messages inside the recent window keep their chronological place, so the newest round is always last; the next turns are append-only again, and the prefix monitor is told the change is deliberate.
- **Failures:** if the summary call fails, or the summary comes back over 800 tokens (twice the planned size), or not even one round fits the summariser's window, the run stubs every eligible result instead and emits a `warning`. If the prompt still does not fit after every stage, the run fails with `context_overflow` (sizes in `details`) rather than sending an oversized request. If the non-compactable messages alone exceed 60% of the budget the run warns once; above 90% it fails with `context_overflow` ("Non-compactable context too large").
- **Events and usage:** one `{ type: 'compaction', stage: 'stubbed' | 'deduped' | 'summarised', tokensBefore, tokensAfter, messagesAffected, summaryTokens? }` event per stage applied. `TaskResult.usage` (and the run record) carries `compactions`, `compactionTokens` (the summariser's input plus output tokens, also counted in `inputTokens`/`outputTokens`) and `compactionTokensSaved`. `ai.report()` adds a `frequent-compaction` finding for runs that compacted more than once every five turns.

## Prompt compression (pluggable `Compressor`)

An agent can compress its prompt text with a `Compressor`. **No compressor ships with the library**: a learned compressor such as LLMLingua-2 needs a model download, so it belongs in a plugin you install and approve yourself. Without `compression` nothing changes.

```ts
interface Compressor {
  id: string;      // part of the cache key and the agent version
  version: string; // bump when output for the same input could change
  compress(input: { text: string; targetRatio: number; protect: string[]; signal?: AbortSignal }): Promise<{ text: string }>;
}

ai.agent({
  name: 'researcher', model: 'anthropic:claude-sonnet-5-5', context: longEnvironmentNotes,
  compression: {
    compressor,
    targetRatio: 0.5,     // keep about half (default)
    minTokens: 200,       // leave shorter texts alone (default)
    fields: { persona: false, skillset: false, context: true, task: true, references: true, examples: true }, // the defaults
    applyTo: ['toolResults'], // default; still needs the tool's `compressible`
    forceKeep: ['ThemeProvider'],
    timeoutMs: 30_000,    // per compressor call (default)
  },
});
```

- **Static text** (agent `persona`, `skillset`, `context`; task `task`, `context` and each reference's content) is compressed on the agent's first `task()` or `preview()` and memoised on the agent; scope lists, constraints and acceptance criteria are never compressed. Results are cached in the store's `compressed` collection under sha-256(source, compressor id and version, parameters), so the same input always gives byte-identical text, later agents and other runtimes on the same store reuse it, and the prompt prefix stays stable across turns. `persona` and `skillset` are off by default until an evaluation shows compressing them is safe. With `captureContent: false` or a `redact` hook the cache stays in memory, like the tool-result cache.
- **Tool results:** a tool declared `compressible: true` has its successful string results compressed when they are committed to history (the compressed text is stored and sent from then on; the original is kept under a `result_original` handle and named in a note after the text; `result_original` is then in the tool list from the first request, so the prefix never changes mid-run). Results that look like code, diffs or JSON are left alone unless the tool says `compressible: 'allow-code'`. The `tool-result` event always carries the original. `applyTo` also accepts `'history'` and `'retrieval'`, which nothing produces yet.
- **Protected content:** negations and exceptions (not, never, no, nor, cannot, without, unless, except, avoid, none, nothing, neither, nobody and any `n't` contraction, with a straight or curly apostrophe), modals and order words (must, only, shall, before, after), limits (at most, at least, less/more/fewer than, with their number), signed numbers with units (`-5`, `≤10`, `3.5 GB`), file paths, identifiers (camelCase, PascalCase, snake_case), quoted strings, URLs, code spans and fenced blocks, JSON objects, `::aigent` directive lines and every `forceKeep` entry are passed as `protect` and checked afterwards: each must appear as a whole word, in source order (so swapped paths or numbers are caught), and the output must have exactly the source's negations (none dropped, none added). Cache hits are re-checked against the current rules, and the rules' version is part of the cache key. Output that fails is rejected: the original is used and the run warns `Compression of <field> dropped protected content and was ignored`. A compressor that throws, or does not answer within `timeoutMs` (its `signal` is then aborted), is ignored the same way, with a warning; failures are never cached or memoised, so the next run tries again. Stopping a run (`stop`, its `signal` or its `timeoutMs`) while the prompt is being compressed ends it at once as `cancelled` or `limit_reached`, without a provider request. Questions and answers, plan, todo and directive records, the library's own instructions and tool schemas are never compressed.
- **Agent version:** the compressor's id and version and every setting are hashed into `agentVersion`, so before/after comparisons in `ai.report()` work.
- **Telemetry:** each compression a run used is stored on its run record as `{ field, originalTokens, compressedTokens, ratio, latencyMs, cacheHit }` (no text). `ai.report()` adds `compression-net-negative` when the agent's runs with compression succeed less often than its runs without (at least three on each side), or the compressor took longer than 1 ms per saved token.
- **A/B evaluation:** `await ai.evalCompression({ agent: definition, tasks, compressor })` runs each task without and then with the compressor through the agent's own provider (telemetry off) and reports, per task and in total, whether status, answer and plan outcome matched, the input tokens saved and the time difference.
- **Testing:** `fakeCompressor({ dropEvery })` (removes every Nth unprotected word, deterministic) and `createBrokenCompressor()` (drops negations, to see the rejection) are exported from `@anupheaus/aigent/testing`.
- **Writing an LLMLingua-2 plugin:** wrap a token-classification model (for example the community `@atjsh/llmlingua-2` port, or an HTTP sidecar running Microsoft's Python library) in `compress`: keep the tokens it scores highest until `targetRatio` of the text remains, always keep every `protect` substring, and run it deterministically (fixed model weights, no sampling). Give it a stable `id` and bump `version` whenever the model or its settings change, since cached results are keyed by both.

## Previewing the prompt

`await agent.preview(input?)` returns `{ system, brief, tools, pinned?, fields, totalTokens }`: the exact system prompt, task brief, pinned plan message (with a `plan` input) and tool specs a task with that input would start with, compression applied, plus every compressible field with its original and final text and token counts. `totalTokens` counts all of these but not the per-turn volatile block. It calls no provider; it is built by the same code as a run's first request. Without an input the brief is empty.

Each request is checked against the usable budget once it is built (volatile block included): one the volatile block pushed over is never sent, and the run fails with `context_overflow`.

## Plan and todo

A task may bring a **plan**; every agent also keeps its own **todo list**.

```ts
const run = agent.task({
  task: 'Explain how theming works',
  plan: [
    { id: 'find', label: 'Find the provider', description: 'Locate the theme provider component', acceptanceCriteria: ['Path and line reported'] },
    { id: 'explain', label: 'Explain it', description: 'Explain how themes are applied', acceptanceCriteria: ['Covers context and CSS variables'] },
  ],
});
for await (const event of run) if (event.type === 'plan-update') render(event.items);
const { status, plan, todo } = await run;
```

- **Plan:** up to 50 items, each `{ id (1 to 40 chars, unique), label (1 to 80), description (1 to 1,000), acceptanceCriteria (1 to 20, each 1 to 300) }`; duplicate ids, empty criteria and other problems fail with `invalid_input` naming the item. Items start `pending`.
- **`plan_complete`** (registered only when a plan is supplied): `{ updates: [{ id (at most 40), status, evidence? (at most 500) }] }`, 1 to 50 updates, one envelope per update (`{ index, ok, result: { id, changed } }` or `{ index, ok: false, error }`), so valid updates apply even when others fail. Rules, each with its own error code: an unknown id is `unknown_plan_item` (the `suggestion` lists the valid ids); `done` without evidence (empty or whitespace-only evidence counts as none; evidence is stored trimmed) is `evidence_required`; leaving `done` (or leaving `blocked` for `pending` / `in_progress`) without evidence giving the reason is `status_regression` (with evidence it is allowed and recorded); repeating the current status is an idempotent success.
- **`todo`** (registered for every agent unless `ai.agent({ todo: false })`): `{ ops: [{ op: 'add' | 'edit' | 'delete' | 'set_status', id? (at most 40), label?, description?, status?, reason? }] }`, 1 to 50 ops, one envelope per op. `set_status` back from `done` (or from `blocked` to `pending` / `in_progress`) needs a non-blank `reason`, the same rule as plan items, else `status_regression`. Directives take the same shapes and the same limit of 50. `add` needs a label and generates `t1`, `t2`... unless it gives an id. The list holds at most 100 items and its `## Todo` section at most 8,000 characters; past either, `add` fails with `todo_full` telling the agent to delete or merge items. Items are never dropped silently.
- **Directives:** `::aigent plan {"updates":[...]}` and `::aigent todo {"ops":[...]}` go through the same rules as the tools. They apply as they arrive in the stream, so a directive and a tool call in the same turn take effect in arrival order. A rejected entry emits a `warning` with the precise reason, and a one-line correction appears in the next request's volatile block (`## Corrections`).
- **Prompt layout:** the plan definitions (ids, labels, descriptions and criteria) go in one pinned `user` message directly after the task brief, inserted before the first request and never rewritten, so the prompt prefix stays byte-stable. Everything that changes during a run is rendered in the volatile block instead: plan statuses as `## Plan status`, and the agent's todo list (ids, statuses, labels and descriptions, which change often) as `## Todo`. A todo add, edit or delete therefore never invalidates the provider's prompt cache, and the prefix monitor is never told to ignore a change.
- **Events:** `{ type: 'plan-update', items, changed }` and `{ type: 'todo-update', items, changed }` (the whole plan or list, and the ids that changed), emitted as soon as a change applies.
- **Result:** `TaskResult.plan` (when a plan was supplied) and `TaskResult.todo` (when the list is not empty) hold the final items. A run that would otherwise be `completed` is `incomplete` while any plan or todo item is not `done`; that includes the agent's own todo items, so an agent should delete items it decided not to do rather than leave them pending. The run record stores `plan` and `todo`; with `captureContent: false` only their ids and statuses.
- `plan_complete` and `todo`, like `aigent_feedback`, are bookkeeping: they never count against `maxToolCalls` or toward `usage.toolCalls`, carry no `previous` field and never receive outcomes.

## Shaping tool results (verbatim by default)

Tool results reach the model **verbatim by default**: nothing alters a result unless its tool opts in. A tool opts in by declaring what its result contains and that a lossy, shorter form is acceptable:

```ts
const runCommand = defineTool({
  name: 'run_command', description: 'Run a shell command', args: z.object({ command: z.string() }).strict(),
  deterministic: false, cache: false,
  contentKind: 'command-output', // file-content | web-page | command-output | structured-data | search-hits | prose | log | binary-ref
  fidelity: 'lossy-ok',          // default 'verbatim'; 'lossy-ok' needs a contentKind
  describeActivity: ({ command }) => ({ title: command }),
  run: async ({ command }) => exec(command),
});
```

**Rules.** A shaper runs on a result only when the tool declared `fidelity: 'lossy-ok'` **and** the shaper's `appliesTo` lists the tool's `contentKind`. Every shaper must declare a non-empty `appliesTo` (registering one without it throws `invalid_definition`). No built-in shaper lists `file-content` or `binary-ref`, so file bytes are never shaped, even by a tool that declares them `lossy-ok`. Results of `aigent_multi` inner calls are not shaped. The cache always holds the original; shaping applies to the copy the model sees, before `maxResultTokens` truncation. Trace sizes (`resultBytes`, `resultTokens`) are the original's.

| Shaper | Applies to | What it does |
| --- | --- | --- |
| `dedupe-reads` | structured-data, search-hits, prose | a result identical to an earlier call's in the run becomes `Same as call <id> (unchanged)` |
| `strip-noise` | command-output | removes ANSI escapes, carriage-return progress overwrites, trailing whitespace and runs of more than 2 blank lines |
| `fold-repeats` | log, command-output | 3 or more identical consecutive lines become `line (xN)` |
| `html-boilerplate` | web-page | removes scripts, styles, `nav`, `footer`, `aside` and comments, and collapses whitespace |
| `tabular` | structured-data | an array of 3 or more flat objects with the same keys becomes `{ columns, rows }` (lossless) |
| `aliases` | structured-data, search-hits | long strings (24+ characters) repeated in a result become `F1`, `F2`... |

**What the model sees.** A shaped result is `{ result: <shaped>, shaping: [{ shaper, note, handle }] }`; a verbatim result is unchanged. The `note` says what was removed and names a handle (`H1`, `H2`... per run) under which the verbatim original is kept. The built-in **`result_original`** tool (`{ handles: [1 to 10 handles] }`, one envelope per handle with `{ handle, text }`) returns the originals; it is registered only when a tool declares `lossy-ok` and shaping is not off.

**Aliases.** The `aliases` note gives the legend (`F1 = "src/components/theme/ThemeProvider.tsx"`). The model may write an alias back only to tools that opt in with `acceptsAliases: true` (set it for tools whose arguments are references such as paths or ids, never for literal values such as keys, cells or file content). For those tools an argument string that is exactly an alias issued earlier in the run is expanded (at any depth; substrings, keys and unknown tokens are left alone) before the arguments are validated, cached, traced or run. Inside `aigent_multi` each inner call follows its own tool's opt-in. Every other tool, including `plan_complete`, `todo` and `aigent_feedback`, receives `F1` literally. The alias table is run state.

**Control.** `ai.agent({ shapers: 'off' | { allow: ['fold-repeats', ...] } })` turns shaping off or limits it to the named built-in shapers; a task's own `shapers` wins. Unknown names fail with `invalid_definition` (agent) or `invalid_input` (task). Each trace step records `shaped: [{ shaper, tokensBefore, tokensAfter }]`, and `ai.report()` adds a `net-negative-shaper` finding for a shaper whose output, summed over an agent's runs, was not smaller than its input.

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

- **Key:** a sha-256 of the canonical JSON of the tool name, its `version`, a hash of its argument schema, its `description` and the normalised arguments (plus, for instance-scoped entries, the tool's per-definition id). Argument key order never matters, `previous` and alias tokens are removed or expanded before the key is computed, and a changed schema, description or version never collides with older entries.
- **Scope:** `deterministic` means *same name, version, schema, description and arguments give the same bytes for everyone sharing the namespace*. By default a deterministic tool's results are shared only by the instances of the requesting agent (namespace `agent:<agentName>:<version>`), so two agents whose same-named tools are bound to different data (two repositories, two tenants) never see each other's results. A tool opts into wider sharing with `cacheNamespace: 'repo-a'` (every tool using that namespace shares, in any agent or runtime on the store; namespace `ns:repo-a`) or `sharedCache: true` (every agent, namespace `global`); only do that when the results really are the same for all of them. A cached non-deterministic tool must declare `cacheTtlMs`, and its results stay private to the agent instance (`instance:<instanceId>`) and to the tool definition that produced them. Entries expire after `cacheTtlMs` when it is set, measured with the injected clock.
- **Validity:** when a tool defines `validity`, the token is computed before every lookup and stored with the entry. An entry whose token changed is never served: the call runs again, replaces the entry and counts as an invalidation. A `validity` or `cacheKey` that throws makes that call run uncached.
- **Never cached:** failed calls (including timeouts and aborts), batch results with a retryable item failure (a 503, a timeout, a DNS failure: the retry the model is told to make must reach the source), results larger than `maxEntryBytes`, and tools with side effects.
- **Copies:** results are deep-copied when stored and when served, so mutating a result never changes a later hit. The cache holds the full result; `maxResultTokens` truncation applies to each served copy.
- **Single-flight:** identical calls that arrive while the first is still running wait for it and are then served from the cache, so the tool runs once. If the first call fails (or shaping or summarising its result throws), the waiting calls run themselves; a miss always releases its waiters. A lookup (computing `validity` and waiting for another call) is bounded by the run's signal (the call fails as aborted) and by the tool's `timeoutMs` (the call then runs uncached).
- **Per-runtime limits with a shared store:** the single-flight, the eviction index and `maxEntries` / `maxBytes` belong to one `createAigent` runtime. When several runtimes or processes share one store, two of them can both miss and run the same call, each enforces the limits only over the entries it stored or saw when its index was first loaded, and entries written by the others are neither indexed nor evicted by it. Statistics stay exact per entry, since every update is a compare-and-set.
- **Eviction:** beyond `maxEntries` or `maxBytes` of live entries, the least recently requested entries are evicted. An evicted entry is deleted (`Store.delete`, an optional store capability the in-memory store implements) and its statistics are added to one summary record per tool (`summary:<tool>`), so findings still see its history while the collection stays bounded. A store without `delete` keeps a small tombstone instead (value dropped, statistics kept).
- **Storage:** entries live in the runtime `store`, collection `toolcache`, keyed `${namespace}:${key}`, as `{ schemaVersion, namespace, tool, storedAt, agentName, runId, recordedAt, expiresAt?, validity?, value, bytes, originalDurationMs, resultTokens, evicted?, stats }`. `stats` holds `firstStoredBy`, `totalHits`, `hitsByAgent`, `missesByAgent`, `lastRequestedAt`, `missCount`, `invalidationCount`, `savedMs` and `savedTokens`, all updated through the keyed write queue so they are exact under concurrency. Without a store, with `captureContent: false`, or with a `redact` hook, entries go to a private in-memory store instead: tool results never reach a store whose owner asked for no content, and they are never stored unredacted next to redacted telemetry (redacting a cached result would serve altered data back, so the cache is kept out of the store rather than redacted). In the runtime store, entries carry `agentName`, `runId` and `recordedAt` of the call that stored them, so `ai.purge({ agentName | runId | before })` removes them like other records, and `retention.expiresInMs` caps `expiresAt` (an entry is never served after it).
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
  | `net-negative-shaper` | a shaper's output, summed over the agent's runs, was not smaller than its input |

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

## Guardrails

```ts
const noPrices = defineGuardrail({ name: 'no-prices', stage: 'output', check: text => (/\$\d/.test(String(text)) ? { action: 'block', reason: 'prices are not allowed', code: 'price' } : { action: 'allow' }) });
const ai = createAigent({ providers, guardrails: { builtins: { pii: { output: 'redact' }, scope: { denyTools: ['drop_table'] } }, custom: [noPrices], failMode: 'closed', timeoutMs: 2_000 } });
const result = await agent.task({ task: 'Largest city in Norway?', output: z.object({ city: z.string(), population: z.number() }) });
result.output; // { city, population }, validated
```

A guardrail is a check `(value, ctx) => allow | rewrite | block` at one stage: `input` (the task text, or the chat message being answered), `toolCall` (before a call runs, including calls inside `aigent_multi`), `toolResult` (before the model sees a result), `output` (the final answer) and `stream` (visible text deltas). Built-ins run first, in a fixed order, then custom ones by `order` and registration. Rewrites chain; the first block stops the stage. A check that throws or takes longer than `timeoutMs` (default 2000) blocks with `failMode: 'closed'` (the default) and is allowed with a warning with `'open'`, unless the guardrail is `blockLevel`. Guardrails make no provider calls.

- **Blocks are visible:** a blocked call or result becomes a `denied` envelope with code `guardrail_blocked`, the reason, a suggestion and `details: { guardrail, code }`, so the agent can adapt; a blocked input fails the run before any request; a blocked answer is replaced (with a `warning`). Every decision other than allow is a `guardrail` event, is listed in `result.guardrails`, and is stored on the run record and the call's trace step (messages only with content capture on); `ai.report()` has a `guardrail` finding per guardrail that blocked.
- **Built-ins** (each on unless set to `false` in `builtins`): `secrets` redacts API keys (`sk-`, Stripe, AWS, GitHub, GitLab, npm, Hugging Face, Slack, Google), bearer tokens, JWTs, private keys (one cut short is redacted to the end), credentials in connection strings and `password=...`-style values, also under env-style names (`DB_PASSWORD=`, `"aws_secret_access_key":`), as `[REDACTED:<kind>]` in tool results (failed calls' error texts too), the answer, the stream and the reasoning (hashes and UUIDs are not secrets; zero-width characters inside a key are seen through, but spaced-out or look-alike characters are not: it is a pattern check, not a guarantee). `pii` finds emails, phone numbers, card numbers (Luhn) and IBANs (mod 97): `warn` on output and `off` for tool results by default, or `redact` (output `redact` also redacts the stream). `injection` quarantines tool results that try to instruct the agent (override phrases, `::aigent` lines, role markers, fake tool calls or approval claims): the result becomes a labelled data block with directives defused. Tool output can never grant approvals or permissions, nor trigger directives (only the model's own stream is parsed for them). `scope` blocks calls to tools in `denyTools`, outside `allowTools` (`aigent_multi` itself is allowed; its inner calls are checked), or named in the task's `outOfScope`, and warns when the answer mentions a `forbiddenTerms` entry. `loop-guard` blocks the 4th identical call (same tool and arguments) of a run (`maxRepeats`) and truncates an answer over `maxOutputChars` (200_000; a structured answer is never cut: it fails with `output_too_long`). `output-schema` validates the answer as the model wrote it (before any rewrite) against the task's `output` schema (JSON, or the text itself with `outputFormat: 'text'`): the brief states the schema, a failing answer goes back to the model with the issues for up to `retries` (2) more turns (bounded by the turns left), then the run fails with `output_invalid` and its answer as rewritten (never raw); `result.output` holds the parsed value of the rewritten answer, and is omitted with a `warning` when a rewrite (a redaction) made it invalid. A structured task whose answer a guardrail blocks fails.
- **Every path to the model is checked:** `toolResult` checks run before the call ledger stores a result, over results a resumed run restores or runs again, and over a failed call's `message`, `suggestion` and `details` (a quarantine becomes the message).
- **Stream hold-back:** with a `stream` guardrail on (the `secrets` built-in), streamed text and reasoning are each held back by `holdBackChars` (64, at least 16) and from wherever a secret may still be growing (including the first characters of a known prefix), so a secret split across chunks is redacted before any of it is shown; the emitted deltas are exactly the checked text (so short replies may arrive in one piece), and `thinking-done` is built from them. History, checkpoints and chat transcripts store this guarded text, never the raw stream. When the settled answer differs from what was streamed, a `text-retracted` event withdraws it. `stream` checks must be synchronous (an async one is reported once per run and handled per `failMode`). Checks get no abort signal: a timed-out async check keeps running in the background, and a synchronous check that never returns cannot be bounded.

## Dry runs

```ts
const writeFile = defineTool({
  name: 'write_file', /* ... */ hasSideEffects: true,
  run: async ({ path, content }) => fs.writeFile(path, content),
  dryRun: async ({ path, content }) => [{ kind: 'file.write', target: path, summary: `write ${content.length} characters`, before: await readIfExists(path), after: content, reversible: true }],
});
const result = await agent.task({ task: 'Tidy the config', dryRun: true }); // or agent.chat({ dryRun: true })
result.plannedEffects; // [{ tool, callId, kind, target, summary, before?, after?, reversible }]
```

With `dryRun: true` nothing changes: read-only tools run normally, a tool with side effects is asked for `dryRun(args, ctx)` instead of `run` (it returns the effects, or `{ result, effects }`), and the model sees a clearly marked simulated result `{ simulated: true, result?, effects }`. A mutating tool without `dryRun` is refused (`denied` / `dry_run_unsupported`) and never runs. Batch tools declare `dryRunItem`, and calls inside `aigent_multi` are simulated one by one. The volatile block tells the model it is a dry run; simulated calls skip approvals, are never cached and never shaped. Each call's effects arrive as a `planned-effects` event, all of them in `result.plannedEffects`, and the run record gets `dryRun: true` and `plannedEffects` (`before`/`after` bounded to 2000 characters; targets and texts only with content capture on). Only tools with side effects may declare `dryRun`.

## Undo

```ts
const writeFile = defineTool({
  name: 'write_file', /* ... */ hasSideEffects: true,
  run: async ({ path, content }) => { const previous = await readIfExists(path); await fs.writeFile(path, content); return { previous }; },
  undo: async ({ path }, result) => ({ path, previous: result.previous }),      // plain JSON, captured right after the call
  applyUndo: async ({ path, previous }) => { await restore(path, previous); return { ok: true }; },
});
const ai = createAigent({ providers, store, undo: { retentionMs: 7 * 24 * 60 * 60_000 } });
const report = await agent.undo({ runId }); // or { runId, callId }, { callId } or { since: epochMs } (add scope: 'agent' for every instance)
report.results; // newest first: [{ effectId, callId, tool, status: 'undone' | 'failed' | 'unavailable' | 'already_undone' | 'expired', message? }]
```

Every successful call of a tool with side effects is appended to the effect log (collection `effects` in the runtime store, in memory without one; through the keyed write queue and `redact`), with the descriptor its `undo(args, result, ctx)` returned, or as not undoable. `undo` and `applyUndo` are declared together, on tools with side effects only. `agent.undo(target)` reverses the matching effects newest first through `applyUndo(descriptor, ctx)` (bounded by the tool's timeout): a failing undo is reported and the rest still run, an effect already undone is `already_undone`, one whose tool records no undo data (or is not the agent's any more) is `unavailable`, and one past `undo.retentionMs` is `expired`. `{ runId }` (optionally with `callId`) names a run exactly; `{ callId }` and `{ since }` cover the calling agent instance only unless `scope: 'agent'` (one agent definition usually serves many users), and a bare `callId` that matches calls of several runs is refused (`invalid_input`); a run renames any call id the provider repeats (servers that omit ids give every response `call_0`). Descriptors carry a hash taken before `redact`: a descriptor that `redact` changed is `unavailable`, never applied (it would write the masked content back), so keep undo data out of what your `redact` masks. A store failure while recording an undo is reported on that effect (still `undone`), the rest still run, and the process never applies it twice. A call's effects are also kept in its ledger entry with `resume`, so a crash before the effect-log write loses no undo data. Each applied undo is recorded in the log too (`kind: 'undo'`), concurrent undos of one agent are serialised, and descriptors survive the store, so a fresh runtime with the same agent and tools can undo. Trace steps whose call can be undone have `undoable: true`. Calls inside `aigent_multi` are recorded as well; dry runs and `persistence: 'memory'` chats record nothing.

## Human approvals

```ts
const deleteFile = defineTool({
  name: 'delete_file', /* ... */ hasSideEffects: true, risk: 'high',
  requiresApproval: { reason: 'Deleting is permanent' }, // or true, or (args, ctx) => boolean, or { when, reason }
});
const ai = createAigent({ providers, approvals: { allow: [{ tool: 'delete_file', argsMatch: { dir: '/tmp' } }], deny: [{ tool: '*', when: args => isProtected(args) }] } });
for await (const event of run) {
  if (event.type === 'approval-request') await agent.approve(event.requestId, { decision: 'allow_once' }); // or 'allow_always' (with scope) or 'deny'
}
```

- **Gate:** before a call whose tool requires approval (for these arguments) runs, the rules apply first: a matching `deny` rule wins over any `allow` rule (rules match a tool name or `*`, exact top-level `argsMatch` values and an optional `when`). Otherwise the run emits `approval-request` (`requestId`, `callId`, `tool`, `argsSummary`, `risk`, `reason` and the tool's `describeActivity` view) and that call waits; other calls and the stream go on. `agent.approve(requestId, { decision, scope?, note? })` decides it: `allow_once`, `allow_always` or `deny`. Every decision emits `approval-decision` (`by: 'rule' | 'user' | 'policy'`). Calls inside `aigent_multi` are gated one by one exactly like top-level calls (their `callId` is `<wrapperId>:<innerId>`); used outside a run, `aigent_multi` refuses inner tools that require approval (`approval_required`).
- **`allow_always` scope:** by default the new rule covers this tool with exactly these arguments, for this agent instance only. `scope: { argsMatch }` narrows it to those top-level values, `scope: { anyArgs: true }` covers any arguments, and `scope: { across: 'agent' | 'runtime' }` widens it to every instance of the agent or every agent of the runtime. A scope naming another tool (or `*`) is refused with `invalid_input` and the request stays pending. These rules live in memory: a restart forgets them. A resumed run re-asking about an interrupted call is never approved by an allow rule (deny rules still apply).
- **Refusals the agent can see:** a denied call gets a `denied` envelope with code `approval_denied`, a reason and a suggestion, so the model can adapt. Unattended runs never wait: without a matching allow rule the call is refused this way (`by: 'policy'`). Stopping a run while a request is pending (any stop, graceful included) refuses it (`approval_aborted`) and cleans up, so a graceful stop never waits for a person.
- **Audit trail:** every decision, by rule, user or policy, is appended to collection `approvals` as its own record, keyed `<requestId>:<sequence>` (`{ requestId, sequence, runId, agentName, instanceId, tool, argsHash, decision, by, at, note }`), through the keyed write queue and `redact`; a request decided again later (aborted, then decided after a restore) keeps every decision.
- **Durable:** with `resume`, a pending request is part of the run's checkpoints (never part of the compactable history); if that checkpoint cannot be written the run emits a `warning` (the request still waits, but would not survive a restart). After a restart it can be decided with `agent.approve` (once `agent.ready` resolved) and `agent.resume()` then runs or refuses the call accordingly. In a chat, closing the session stops a turn waiting for approval (it never holds `close()` open); the reopened session restores the request, and deciding it continues that turn. A resumed run also asks before re-running an interrupted call whose tool's `resume` policy is `ask`.

## Resuming agent instances

```ts
const ai = createAigent({ providers, store, resume: { lease: { ttlMs: 30_000 } } });
const agent = ai.agent({ ...definition, instanceId: 'support-bot-7' });
await agent.ready;                 // lease taken (instance_locked while another runtime holds it)
const run = agent.resume();        // the latest interrupted run, or undefined
const result = await (run ?? agent.task(input));
// or: const restored = await ai.restoreAgent('support-bot-7'); (its definition must have been given to ai.agent)
```

- **What is written:** with `resume`, every run (task or chat turn) writes checkpoints at `start`, after each compaction, when a model response with tool calls is in (`message`), after each round (`turn-complete`) and at its end; every work call is recorded in the call ledger before it runs. The instance record (`instances/<instanceId>`) lists the instance's runs, their status and its chat sessions.
- **`agent.resume({ runId?, onQuestion?, signal?, output? })`** continues the latest run that had not ended (or was stopped gracefully) from its last checkpoint, with the same run id: plan, todo, totals, `result_original` originals and the alias table are restored, and the next request is the one the run would have sent (the prompt prefix is byte-identical, so the provider's prompt cache can still hit). A response that was in when the run stopped is not asked for again: its round is completed from the ledger. Finished calls are never executed again (their recorded result is used); calls that had started follow their tool's `resume` policy (`rerun`, `verify`, `ask`: refused with an `approval_denied` result the model sees in unattended runs, or `skip`: a `skipped` result). Calls that never started run as new calls. A model response lost mid-stream is lost: the model is asked again, with any calls that had started completed first. A resumed dry run stays a dry run: its interrupted calls are simulated, never run for real. A task's `output` schema is not stored (it would not survive a JSON store): resuming a run that had one needs `agent.resume({ output })` (without it, `invalid_input` says so).
- **`aigent_multi`:** each inner call has its own ledger entry (`<wrapperId>:<innerId>`, with `parentCallId`) and idempotency key (`<runId>:<wrapperId>:<innerId>`). The wrapper has no resume policy of its own: a resumed run settles each inner call by its own ledger entry and its own tool's policy, so a finished inner side effect never runs again.
- **Stale checkpoints:** a failed checkpoint write is retried and never leaves a gap. If a record before the head is missing anyway (lost outside the library), the restore uses the last readable checkpoint and emits a `warning` that later work (and its effects) is missing from the resumed context. The ledger only rebuilds the request that was in flight (the turn after the checkpoint), never older rounds a compaction summarised away; a rebuilt round keeps the thinking blocks streamed before its calls, so extended thinking stays valid.
- **Stored content:** `resume` with `captureContent: false` is refused (`invalid_input`): a resume needs the task, messages and arguments. With `redact`, `resume.checkpointRedaction` is required: `'redacted'` passes checkpoints, the ledger and instance records through `redact` (a resume then warns that it continues from the redacted prompt), `'raw'` stores them unredacted so a resume sends exactly the original prompt.
- **Chats:** a turn suspended in `ask_user` (or waiting for an approval) records its suspension in the session's checkpoints; after a restart (`agent.chat({ sessionId })`), answering its questions (or deciding the request) continues that turn rather than starting a new one. A reopened session reads its latest snapshot and only the patches after it, so restore cost does not grow with the session.
- **Leases:** `ai.agent({ instanceId })` opens the instance at once (`agent.ready`); an agent with a generated instance id opens nothing until its first run, so creating agents never takes leases. A second runtime gets `instance_locked` until the lease expires, then takes over with a higher fence, and the old owner's late writes are rejected. A renewal that fails for a transient reason is retried until the lease would expire; once it is lost (taken over or expired) the instance's runs emit a `warning`, write nothing more and stop at once (`resume.onLeaseLost: 'graceful'`: at the next safe boundary). A failed open releases its lease, `agent.close()` releases one instance after its runs, `ai.close()` releases every lease, and heartbeat timers never keep the process alive. `lease: false` turns leases off.
- **Agent versions:** restoring an instance with a different `agentVersion` emits a `warning` on its next run and records the new version; the restore proceeds.
- **Determinism:** restore reproduces state, not the model's randomness: a response lost in the crash may come back different, but the prompt and every recorded result are identical.

## Checkpoints, call ledger and leases

The building blocks of resumable instances (`src/resume`):

- **Checkpoints** are append-only records in collection `checkpoints` (key `<instanceId>:<runId|sessionId>:<seq>`, `schemaVersion` 1), written through the keyed write queue and `redact` at each safe boundary (`start`, `message`, `turn-complete`, `compaction`, `question`, `approval`, `end`...). Every 25th record (and any record after the history was rewritten, e.g. by a compaction) is a full snapshot; the others hold only the messages appended since. A head record (`checkpoint-heads`) names the latest seq and the kept snapshots, so a restore reads the head, the latest snapshot and its tail, never the whole log. After each snapshot, records older than the last two snapshots are pruned (stores without `delete` keep them). Older schema versions are upgraded on read (`migrateCheckpoint`; v0 is the pre-release shape).
- **Call ledger:** every tool call (and every `aigent_multi` inner call) is recorded `started` in collection `calls` (one record per run) before the tool runs, then `done` or `failed` with the envelope the model was given. Its idempotency key `<runId>:<callId>` (`<runId>:<wrapperId>:<innerId>` inside `aigent_multi`) reaches the tool as `ToolContext.idempotencyKey`, so a tool can make a remote effect happen once.
- **Tool resume policy:** `defineTool({ resume: 'rerun' | 'verify' | 'ask' | 'skip', verify })` says what a resumed run does with a call that had started but not finished. The default is `rerun` for tools without side effects and `ask` for tools with them; `resume: 'verify'` requires `verify(args, ctx)`, which says whether the effect already happened (`{ done, result? }`).
- **Leases:** one live owner per instance. A lease (`leases/<instanceId>`: `{ ownerId, fence, expiresAt }`) is taken with compare-and-set; while another owner's lease is unexpired, acquiring fails with `instance_locked`. Taking over an expired lease increments the fence, a heartbeat renews it every third of its TTL until it is released, and every checkpoint, ledger and chat write of the instance goes through a fenced store. Each record carries the fence of the owner that wrote it (`leaseFence`), checked inside the same compare-and-set as the write, so a record a newer owner wrote is never replaced or deleted by an older one, whatever the interleaving (`store_conflict`, `details.fenced: true`); a write the stale owner had in flight at the takeover may still land, ordered before anything the new owner writes to that key. A newer owner's create replaces an older owner's record. Fenced deletes leave a small tombstone (a store delete cannot be conditional), which reads through the fenced store skip.

## Built-in tool packs

Packs are opt-in, each from its own entry point, and follow the same rules as your own tools: strict schemas, batch-first (an `items` array, up to 50, one envelope per item so one bad item never fails the others), declared `deterministic` / `cache`, `contentKind` / `fidelity`, a `maxResultTokens` budget and an activity renderer whose failure detail comes from the structured error.

### Filesystem (`@anupheaus/aigent/tools/fs`)

```ts
import { createFsPolicy, fsTools } from '@anupheaus/aigent/tools/fs';

const policy = createFsPolicy({
  roots: [{ path: '/srv/project', permissions: ['read', 'write', 'delete'], label: 'workspace' }, { path: '/srv/docs', permissions: ['read'] }],
});
const agent = ai.agent({ name: 'coder', model, tools: fsTools({ policy, backupDir: '/srv/.aigent-backups' }) });
```

- **The policy decides, deny by default.** Without roots every call is refused (`no_roots`). Every path is canonicalised before it is checked: made absolute (relative paths start at the first root, or `cwd`), separators normalised, `..` applied, then the longest existing prefix is resolved through `realpath`, so a symlink or junction out of a root is outside it. The canonical path that was checked is the one the tool then uses. `fs_stat`, `fs_move` and `fs_delete` resolve only the parent, so they act on a final link itself (a link is described, renamed or removed; its target is never touched). Refusals are `denied` envelopes with a code (`outside_roots`, `permission_denied`, `denied_glob`, `invalid_path`, `too_large`) and a suggestion. Names with invisible formatting characters (bidirectional overrides, zero-width spaces) are refused everywhere. On Windows, drive-relative paths (`C:foo`), device paths (`\\?\`, `\\.\`), UNC paths (unless a root is UNC), alternate data streams (`a.txt:stream`), reserved names (`NUL`, `COM1`...), 8.3 short names (`PROGRA~1`) and names ending in a dot or space are refused; names compare case-insensitively on Windows and macOS. NUL and control characters, paths over 32,767 characters and segments over 255 are refused everywhere.
- **Deny globs:** by default `.git` contents, `.env` and `.env.*`, `*.pem` and `*.key` are refused for every operation, and `node_modules` for writes and deletes. `denyGlobs` replaces the list (for every operation). The innermost root decides, so a read-only root inside a writable one stays read-only. Limits: `maxReadBytes` and `maxWriteBytes` (1 MiB each by default), `maxFiles` (entries a listing or search visits, default 10,000). `approval(op)` can ask for approval of specific operations; it always sees the canonical path (relative, `..` and alternate-separator spellings are resolved first), and a call whose path only resolves to a protected one through a link is refused when it runs (`approval_required`) rather than run unapproved. Moving or deleting a directory that holds a nested root (`contains_root`) or any entry a deny glob protects, where it is or (for a move) where it would land (`contains_protected`), is refused; the check walks without following links and fails closed past `maxFiles` (`too_many_entries`).
- **`fs_read`** `{ path, offset?, limit?, raw? }` returns `{ path, text, startLine, endLine, totalLines, truncated, encoding, bytes }`. Text is shown with LF line endings and without a BOM; `raw: true` returns it byte-faithfully (BOM and CRLF kept). Files over `maxReadBytes` are read in parts (use `offset`); lines over 20,000 characters are cut with a marker; binary files return `{ binary: true, bytes, mimeGuess }` instead of content. Results are verbatim `file-content` (never shaped), cached by canonical path and invalidated by the file's mtime and size, so a read after an edit is never stale.
- **`fs_list`** `{ path, recursive?, depth? (≤ 8), glob?, includeHidden?, includeIgnored?, limit? (≤ 2000) }` returns sorted entries `{ path, type, size, mtimeMs }`, counts per type and `skipped` counts (with sample paths) for denied, hidden and ignored entries. Symlinks are listed, never followed.
- **`fs_search`** `{ path, pattern, kind: 'name' | 'content', regex?, caseSensitive?, wholeWord?, glob?, contextLines? (≤ 5), maxMatches? (≤ 500), includeIgnored? }` returns `totalMatches` and `filesWithMatches` first, then matches per file (1-based line and column, optional context) in path order, and `skipped` counts by reason (`ignored`, `binary`, `tooLarge`, `denied`, `hidden`, `unreadable`, `link`, `other`; a skipped directory counts once) with sample paths. Dependency, build, VCS, lock and minified files (and the directory's `.gitignore` entries) are skipped unless `includeIgnored`; the skip list is always part of the result. Regular expressions from the model are checked first (nested, alternated or adjacent repetition and back-references are refused: `unsafe_pattern`), then matched in a worker thread under a 10-second budget per search: a pattern that runs over is stopped by terminating the worker, and the result says `stoppedBy: 'time budget'`. Only the directory's own `.gitignore` is applied (not ancestor or nested ones).
- **`fs_stat`** `{ path }` returns `{ exists, type, size, mtimeMs }`; for a symlink or junction, `type: 'symlink'` with `linkTarget` (inside the roots), or `linkTarget: null` with `dangling` or `linkTargetRefused`.
- **`fs_write`** `{ path, content, overwrite?, createDirs? }` refuses to replace an existing file unless `overwrite: true` (an atomic exclusive create otherwise) and writes through a temp file and rename. **`fs_edit`** `{ path, edits: [{ oldText, newText, replaceAll? }] }` applies exact replacements in memory, all or none per file: an `oldText` that is absent (`no_match`) or ambiguous (`ambiguous_match`, use more context or `replaceAll`) leaves the file unchanged. It matches the text as `fs_read` showed it (CRLF as LF) and keeps every byte outside the edits exactly: the encoding (UTF-8, UTF-16 LE/BE), BOM, CRLF and lone CR line endings (new line breaks take the file's usual ending). A file that is not valid in its encoding anywhere (`invalid_encoding`) or would not write back byte for byte (`unsupported_encoding`) is refused, never corrupted. Items for one file are grouped: they apply together or not at all (the others report `not_applied`), and the file is written once. **`fs_move`** `{ from, to, overwrite? }` and **`fs_delete`** `{ path, recursive? }` (allowed roots themselves cannot be deleted).
- **Side effects:** the four mutating tools declare `hasSideEffects`, a `risk`, `resume: 'verify'` (a resumed run checks content hashes, or where things are, before running an interrupted call again), `dryRun` (planned effects with a `+added -removed lines` summary; nothing changes) and undo. With `backupDir`, prior content is backed up and deletes go to a managed trash under it, so `agent.undo` restores writes, edits, moves and deletes; a file changed since is left alone and reported. Without it, overwrites and deletes cannot be undone. `approvals: 'deletes'` (the default) asks before deletes, `'writes'` before every change, `'none'` never (the policy's `approval` can still ask).
- **`access`:** the disk goes through `FsAccess` (`createNodeFsAccess()` by default); `createMemoryFsAccess({ platform, files })` is a faithful in-memory disk, exported for tests only, with posix or Windows path rules.
- **Check-then-use:** the OS resolves a path again when it is used, so each operation re-verifies right before and after it acts: reads open the file and then require that the path still resolves to itself and that the open handle is the file at that path (`FsStat.fileId`); writes verify the parent before and after writing the temp file (removing it if the parent moved) and the result after the rename; moves and deletes verify both parents just before acting. A swap is refused as `path_changed`. The mutating calls of one `fsTools()` run one at a time. Residual limit: Node has no handle-relative or no-follow file operations, so a directory swapped for a link in the instant between the last check and the operation can still redirect that one operation (it is then reported); hard links cannot be told from the file. `backupDir` must be outside every root (`fsTools` throws `invalid_definition` otherwise), and `writeAtomically` replaces the file, so its permissions, ACLs and hard links are not carried over.
- File contents are data: text in a file (instructions, `::aigent` directives) never changes the policy, approvals or the run.

### Data and formats (`@anupheaus/aigent/tools/data`)

`dataTools()` gives five pure batch tools, all `deterministic` and cached in the shared namespace (the same arguments give the same result for every agent):

- **`json_query`** `{ json, query }`: a JSONPath subset over JSON text: `$`, `.key` and `['key']`, `[n]` (negative counts from the end), `*` / `[*]`, `..key`, and filters `[?(@.a.b == 1)]` (`== != < <= > >=` against a number, quoted string, `true`, `false` or `null`) or `[?(@.a)]` (field present). Returns `{ matches, count }` in document order; bad JSON is `invalid_json`, a bad query `invalid_query` with the character it stopped at.
- **`csv_query`** `{ csv, header?, select?, where?: [{ column, op: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'startsWith', value }], orderBy?: { column, direction? }, limit? (≤ 1000) }` returns `{ columns, rows, totalRows, matchedRows, truncated }`. Parsing follows RFC 4180 (quoted fields with delimiters, doubled quotes and line breaks, CRLF, a BOM); numbers compare as numbers. Its results are `lossy-ok` structured data, so a tabular shaper may shorten them.
- **`text_diff`** `{ a, b, context? }`: a unified diff with `added`, `removed`, `unchanged`, `identical` and `minimal`. Each side is limited to 1,000,000 characters and 100,000 lines (`input_too_large`). Myers' shortest edit script is searched within a bounded edit distance and work budget (memory never grows with N·M); past it, lines unique to both sides anchor a patience diff, which is correct but may not be shortest (`minimal: false`). Pure insertions use `-N,0` ranges and a missing final newline is marked `\ No newline at end of file`, so the output applies with `patch`.
- **`regex_extract`** `{ text, pattern, flags?, maxMatches? (≤ 1000) }`: matches with their index, captures and named groups. Patterns are checked first: nested, alternated or adjacent repetition (`(a+)+`, `(a|aa)+`, `\w*\w*`) and back-references are refused (`unsafe_pattern`). That check is a heuristic, not a bound: matching runs in a small pool of worker threads (at most 2, 64 MB heap each) that is terminated at the deadline, so even a pattern that slips through never blocks the process. Text is limited to 1,000,000 characters and matched in chunks of at most 200,000 (cut at line breaks; a match never spans two chunks) under a 2-second budget (`stoppedBy: 'time budget'`, with the matches found before it).
- **`calc`** `{ expression }`: `+ - * / % ^` (`^` right-associative and tighter than unary minus), parentheses, `min max abs round floor ceil sqrt pow log` and `pi`, `e`, through a small parser: nothing is ever run as code. Arithmetic is double-precision floating point (`0.1 + 0.2` is `0.30000000000000004`). Errors are exact: `division_by_zero`, `not_a_number` (e.g. `sqrt(-1)`, overflow), `unknown_identifier`, `wrong_arity`, `syntax_error` with its position.

### Shell (`@anupheaus/aigent/tools/shell`)

```ts
import { createFsPolicy } from '@anupheaus/aigent/tools/fs';
import { createShellPolicy, shellTools } from '@anupheaus/aigent/tools/shell';

const policy = createShellPolicy({
  commands: [{ name: 'npm', resolvedPath: '/usr/bin/npm', argRules: { allowSubcommands: ['test', 'run'] } }, { name: 'node', requiresApproval: true }],
  searchDirs: ['/usr/bin'],
  cwdPolicy: createFsPolicy({ roots: [{ path: '/srv/project', permissions: ['read'] }] }),
});
const agent = ai.agent({ name: 'builder', model, tools: shellTools({ policy }) });
```

- **The policy decides, deny by default.** Without `commands` everything is refused (`no_commands`). The model names a program exactly as configured: a path (`./git`, `/usr/bin/git`), another case (`GIT`) or an extension (`git.exe`) is `command_not_allowed`. The executable is found only through the command's `resolvedPath` or the policy's `searchDirs` (never the parent's `PATH`; on Windows `.exe` and `.com`, never batch files), and with `strictResolve` (the default) its real path after links must still carry the allowed name (`command_mismatch`). Arguments are checked for NUL characters, count (`maxArgs`, default 64), total length, `allowSubcommands` and `denyArgs` (a string matches exactly or as `--opt=...`; a RegExp is tested). The working directory must pass the `cwdPolicy` read check (`cwd_denied`). `allowShell` can only be `false`: nothing ever runs through a shell.
- **`shell_run`** `{ command, args, cwd?, timeoutMs?, stdin?, raw? }` (up to 5 items, run one at a time in order unless `sequential: false`, then in parallel within `maxConcurrent`) returns `{ command, exitCode, stdout, stderr, truncated, timedOut, durationMs }`. Arguments are passed literally (`;`, `&&`, `|`, backticks, `$()`, redirects and globs are plain text). A non-zero exit is a result, not an error; policy refusals, a timeout (`timeout`) or a stop (`aborted`) are failures. Output over `maxOutputBytes` (default 200,000 per stream) is cut with a marker. Output is `command-output` and `lossy-ok`: the `strip-noise` and `fold-repeats` shapers may clean `stdout`/`stderr` for the model (the original stays under a `result_original` handle); `raw: true` keeps an item byte-faithful.
- **Processes:** `createNodeProcessRunner()` spawns with `shell: false`, a hidden window and (POSIX) a new process group. On timeout (default 30 s, at most 10 minutes), abort or output overflow the whole tree is killed (`taskkill /T /F` on Windows; SIGTERM, then SIGKILL after 2 s, to the group on POSIX), and processes a finished child left running are killed too, so nothing outlives the call. Inject your own `ProcessRunner` to run elsewhere or in tests.
- **Environment:** the child gets only allowlisted variables (`env.allow`, default `DEFAULT_ENV_ALLOW`: `PATH`, home, temp, locale and Windows system directories; compared case-insensitively on Windows) plus `env.set`; credentials such as `AWS_*`, `*_TOKEN` and `NPM_TOKEN` never reach it. `PATH` is always set: to `searchDirs` when given (on Windows libuv would otherwise copy the parent's).
- **Side effects:** `shell_run` has side effects (`risk: 'high'`, `resume: 'ask'`, no undo). A dry run executes nothing and returns the resolved program, argv, working directory and the environment's variable names. `approvals: 'by-policy'` (the default) asks for commands whose `requiresApproval` is true (or whose predicate matches the argv); `'always'` asks for every call. Unattended runs are refused unless an `approvals.allow` rule grants the call.

### Git (`@anupheaus/aigent/tools/git`)

```ts
import { createShellPolicy } from '@anupheaus/aigent/tools/shell';
import { gitTools } from '@anupheaus/aigent/tools/git';

const policy = createShellPolicy({ commands: [{ name: 'git', resolvedPath: '/usr/bin/git' }], cwdPolicy });
const agent = ai.agent({ name: 'reviewer', model, tools: gitTools({ policy, enableWrites: { commit: true, push: { remotes: ['origin'], branches: ['feature/x'] } }, identity: { name: 'Bot', email: 'bot@example.com' } }) });
```

- **Read tools** (batch, up to 10 items, `repo` per item: a work-tree root with a `.git` directory inside the policy's `cwdPolicy` roots; default the first root): **`git_status`** `{ repo? }` → `{ branch, commit, upstream?, ahead, behind, entries: [{ path, index, worktree, origPath? }] }` from `--porcelain=v2 -z`, never cached. **`git_diff`** `{ repo?, from?, to?, paths?, staged?, contextLines? (≤ 20), maxBytes? }` → `{ diff, stat: { files, insertions, deletions }, truncated }` (no colour, external diff or textconv; cut with a marker). **`git_log`** `{ repo?, ref?, paths?, limit? (≤ 200), since?, author?, grep? }` → `commits: [{ hash, author, date, subject }]` (author and message filters are literal text). **`git_blame`** `{ repo?, path, startLine?, endLine?, ref? }` → `lines: [{ line, hash, author, date, text }]` (at most 2,000). `git_log` and `git_diff` are cached only when pinned to full commit hashes (`ref`, or `from` and `to`).
- **Validation:** git never gets a raw argv. Refs must match `^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,199}$` without `..` (`invalid_ref`); paths must pass the `FsPolicy` (deny globs included, so `.git/config` is refused), stay inside the repository and never start with `-` or `:`, and go after `--` with literal pathspecs.
- **Hardening:** every call carries `-c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=<empty dir> -c protocol.ext.allow=never` (plus no signatures, colour or credential helper) and `--no-optional-locks`; every config key of the repository that could run a program (filters, textconv and diff drivers, pagers, editors, credential and ssh commands, fsmonitor, receive-pack...) is found by listing the effective config (which runs nothing) and cleared. The environment is the policy's scrubbed one without any inherited `GIT_*`, plus `GIT_DIR`/`GIT_WORK_TREE` (git never searches upwards), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, an empty `GIT_CONFIG_GLOBAL` and `GIT_LITERAL_PATHSPECS=1`.
- **`git_commit`** (only with `enableWrites.commit`) `{ repo?, message, paths }` stages and commits exactly those paths (never `-a`, never empty, never amending), always asks for approval (`risk: 'medium'`), runs no hooks unless `enableWrites.commit: { runHooks: true }`, dry-runs as the status of what would be committed, undoes with a soft reset to the previous HEAD only while HEAD is still that commit, and on resume verifies HEAD's message and those paths. Without `identity` the repository's own `user.name`/`user.email` are used.
- **`git_push`** (only with `enableWrites.push`) `{ repo?, remote, branch }` pushes an allowed branch to the same branch of an allowed remote with a refspec without `+` (never forced: a non-fast-forward is refused by git), always asks for approval (`risk: 'high'`), has no undo, and dry-runs with `git push --dry-run`.

### Code intelligence (`@anupheaus/aigent/tools/code`)

```ts
import { createFsPolicy } from '@anupheaus/aigent/tools/fs';
import { codeTools } from '@anupheaus/aigent/tools/code';

const policy = createFsPolicy({ roots: [{ path: '/srv/project', permissions: ['read'], label: 'workspace' }] });
const agent = ai.agent({ name: 'coder', model, tools: codeTools({ policy, tsconfigPath: '/srv/project/tsconfig.json' }) });
```

- **Answers "where is X?" in one call** with the TypeScript compiler's own symbol resolution, for TypeScript and JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, declarations included). Other files are an `unsupported_language` item failure suggesting `fs_search`.
- **`code_outline`** `{ path }` returns `{ path, symbols }`: every declaration (functions with each overload, classes with members, interfaces (merged declarations each listed), types, enums with members, constants and variables, namespaces, the default export and re-exports) with `{ name, kind, line, endLine, exported, signature, children }`, signatures without bodies.
- **`code_find_symbol`** `{ name, kind?, scope?, exportedOnly?, maxResults? }` returns `{ name, total, truncated, definitions }` ranked (exact name, exported, shallow path): `{ name, path, line, endLine, kind, signature, containerName?, exported, reexportedFrom? }`. A renamed import or a re-export chain resolves to the real declaration (an overloaded function to its implementation), which lists the names that lead to it in `reexportedFrom`; library declarations are never results.
- **`code_references`** `{ path, line?, character?, symbol?, maxResults? }` returns `{ symbol, total, skipped, truncated, files: [{ path, usages: [{ line, character, text, kind }] }] }` from the compiler's find-references (through imports, renames and re-exports), each usage classed `definition`, `import`, `call`, `type-ref` or `other`.
- **Only what the policy allows:** each root's code files are listed through the `FsPolicy` (dependency, build and VCS directories skipped, files over `maxReadBytes` counted as `tooLarge`), read through `FsAccess`, and handed to the compiler as its whole disk, so a denied file or anything outside the roots is never read or reported (only TypeScript's own `lib.*.d.ts` come from its package). Programs are built with `noEmit`, `skipLibCheck` and `allowJs` (plus the `compilerOptions` of `tsconfigPath`; `extends` is not followed), hold at most `maxFiles` files per root (5000; past it results carry `incompleteIndex: true`), and are cached per root until any file's mtime or size changes. Results are cached the same way (`validity` hashes every file's mtime and size).
- **TypeScript is an optional peer dependency** (`typescript` 7, whose `unstable/sync` API runs the native compiler in a child process; it is loaded on first use). Its peer range is `*`, so installing the library never conflicts with the TypeScript a project already uses. Without TypeScript 7 every item fails with `typescript_unavailable` saying what to install. The compiler API is synchronous, so a large program blocks the event loop while it builds (the tools' 120-second timeout cannot interrupt it), and the compiler process lives until the program is replaced or the Node process exits.

### Agents and delegation (`@anupheaus/aigent/tools/meta`)

```ts
import { metaTools } from '@anupheaus/aigent/tools/meta';

ai.agent({ name: 'researcher', model, tools: [search] });
const lead = ai.agent({ name: 'lead', model, tools: metaTools({ delegateTargets: ['researcher'] }) });
```

- **`delegate`** `{ agent, task, returnBudgetTokens? }` hands a self-contained task to another agent of the same runtime (the latest `ai.agent` with that name) as a sub-run. Only names in `delegateTargets` are allowed (`agent_not_allowed`); without targets the tool is not registered. The sub-run gets `parent: { agentName, instanceId, runId, callId, depth }` (stored as `RunRecord.parent`), the caller's `unattended` and priority (so it shares the scheduler lanes), and stops with its caller: an immediate stop cancels it, a graceful one stops it at its next boundary. Delegation goes at most 3 levels deep (`depth_limit`) and never back to an agent already up the chain (`delegation_cycle`, from `parent.ancestors`). A run has at most `maxConcurrentDelegations` (default 4) sub-runs in flight (`too_many_delegations`); each sub-run's `maxToolCalls` is reserved from what the caller has left (`maxToolCallsPerDelegation`, default 25, never above the target's own limit; `delegation_budget_exhausted` when nothing is left), and its calls count against the caller's `maxToolCalls`. A sub-run is stopped at once when the delegate call is aborted, when following it fails, or after `delegateTimeoutMs` (default 1 hour), and its usage is still rolled up. Targets may be `{ name, requiresApproval: true }` for agents with broader permissions than the caller: each delegation to them asks a person first. There is no token or cost limit to count against.
- **Result:** `{ agent, runId, status, answer, truncated, usage, errors }`. An answer over `returnBudgetTokens` (default 2,000) is cut with a marker and `fullAnswer: { runId, chars }`, the run whose record holds the whole answer.
- **Roll-up:** the sub-run's progress arrives as `delegated` events (`{ callId, agentName, runId, event }`: its activity, tool calls and results, approvals, warnings and `done`), and its in-flight calls appear in the caller's activity `current` list right after the `delegate` call, with nested ids (`d1/s1`) and `delegatedTo: { agentName, parentCallId }`. Its usage is added to the caller's `usage.delegated` (`runs`, tokens, turns, tool calls and `costUsd` at its own model's price), not to the caller's own token counts.
- **Side effects:** `delegate` declares side effects (a sub-agent may change things), so a resumed run asks before running an interrupted delegation again. In a dry run the sub-run is a dry run too and its planned effects become the delegate call's. The sub-run's effects are logged by its own agent: undo them with that agent's `undo({ runId })`. Its approval requests are decided through its own agent's `approve`.
- `aigent_multi`, `aigent_feedback`, `plan_complete`, `todo`, `ask_user` and `result_original` stay registered by the core.

### Web (`@anupheaus/aigent/tools/web`)

```ts
import { createHttpPolicy, createNodeHttpAccess, webTools } from '@anupheaus/aigent/tools/web';

const policy = createHttpPolicy({ allowDomains: ['docs.example.com', '*.wikipedia.org'], maxBodyBytes: 500_000 });
const agent = ai.agent({ name: 'researcher', model, tools: webTools({ policy, access: createNodeHttpAccess(), search: mySearchProvider }) });
```

- **The policy decides, deny by default.** Without `allowDomains` every URL is refused. `example.com` matches that name only, `*.example.com` its subdomains only (never `evilexample.com` or `example.com.evil.net`), `**` any public host (only with `allowAnyPublic: true`); names compare in punycode, lower case, without a trailing dot. Only `http`/`https`, no `user@host` URLs, ports from `allowPorts` (80, 443). Every address the host resolves to must be public: private (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), loopback, link-local, cloud metadata (169.254.169.254, 168.63.129.16, fd00:ec2::254...) and reserved addresses are refused in every spelling (`2130706433`, `0177.0.0.1`, `0x7f.1`, `[::ffff:127.0.0.1]`, NAT64, 6to4), as are `localhost` and `*.localhost`. `allowPrivateNetwork: true` opens private, loopback and link-local addresses (never metadata). Refusals are `denied` envelopes (`domain_not_allowed`, `private_address`, `port_not_allowed`, `scheme_not_allowed`, `userinfo_not_allowed`, `dns_failed`, `invalid_url`) with a suggestion.
- **Redirects** (up to `maxRedirects`, 5) are followed by the tools, never by the network layer: each hop is checked like the first URL, so a redirect to a metadata endpoint, an off-list host or a name that now resolves privately (DNS rebinding) is refused before it is requested. Requests go to the address the check pinned with `createNodeHttpAccess()`; the default `createFetchHttpAccess()` (global `fetch`) cannot pin, so a DNS answer that changes between the check and the connection is not caught there. Use the node access where rebinding matters.
- **Limits:** bodies are read up to `maxBodyBytes` (1,000,000) and the rest is cancelled, never buffered (a decompression bomb is counted decoded); `timeoutMs` (15,000) covers the whole response, so a slow server is cut off; aborting the run cancels the body.
- **`http_fetch`** (batch, up to 10) `{ url, method?: 'GET' | 'HEAD', headers?: { accept?, 'accept-language'?, 'if-none-match'? } }` (no other request headers) returns `{ url, finalUrl, status, headers (a safe subset), contentType, bodyText?, bodyBytes, truncated, redirected }`. Text is decoded by its charset; a cut body ends with a marker; binary bodies return `binary: true` and no text. Status 400 and above is an `http_error` item failure with a short body excerpt (5xx and 429 are retryable, as is `dns_failed`; a batch with a retryable failure is never cached). Results are verbatim (a batch may mix HTML and data) and cached for five minutes.
- **`page_extract`** (batch) `{ url, maxChars? }` returns `{ title, text, headings, links (≤ 50, absolute http(s)), truncated }`: an in-house tolerant tokenizer drops scripts, styles, navigation, footers, asides and form controls (a page inside one `<form>` is still read; a missing `</head>` is closed by the body, as browsers do), prefers a `main` or `article` element, and never runs anything; huge or malformed pages stay linear. Plain text pages are returned as text; other content is `unsupported_content`. `lossy-ok` web-page results, cached for five minutes.
- **`web_search`** (batch, up to 5 queries) `{ query, limit? (≤ 10) }` needs your `SearchProvider` (`{ name, search(query, { limit, signal }) }`; none ships, and without one the tool is not registered). Results are deduplicated by URL and bounded; a provider error is a `search_failed` item failure.
- Fetched content is untrusted data: with the guardrail built-ins on, page text that tries to instruct the agent is quarantined, and no directive or approval can come from it.

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
- Verbatim-safe shaper pipeline for `lossy-ok` results, originals by handle (`result_original`) and an alias table
- A trailing volatile block (date and time, progress, statuses) and a prompt-prefix stability monitor
- Consumer plans (`plan_complete`), the agent's todo list (`todo`), pinned definitions and plan/todo directives
- Context layout, compaction and the pluggable `Compressor` interface
- Activity updates shared by tasks and chats, run callbacks and `task.steer`
- Resumable instances (checkpoints, call ledger, fenced leases) and human approvals
- Guardrails (secrets, PII, injection, scope, loop and output-schema built-ins plus custom ones), dry runs with planned effects, and the effect log with `agent.undo`
- `agent.chat()`: the UI-ready conversation model (snapshot, gapless patches, `reduceConversation`, `createConversationStore`), persistence by session id, `ask_user`, queue/steer/interrupt delivery, threads, branches, forks, attachments, pins, reactions and auto titles
- Built-in tool packs: filesystem, data/formats, agents and delegation, web (SSRF-safe `http_fetch`, `page_extract`, `web_search`) and code intelligence (`code_outline`, `code_find_symbol`, `code_references`)

Roadmap (later slices, each with its own spec): vision, more built-in tool packs (shell, git, database), an optimisation phase, then learning (memory first, then prompt/strategy tuning and reusable skills), plus store adapters, packaging and release.

## License

MIT
