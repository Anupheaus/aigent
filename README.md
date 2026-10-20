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
- **Presets** are `openAiCompatible` with a fixed id and base URL. Each takes optional `apiKey`, `baseUrl` and `fetch`.

  | Preset | Id | Default base URL |
  | --- | --- | --- |
  | `deepseek()` | `deepseek` | `https://api.deepseek.com` |
  | `openai()` | `openai` | `https://api.openai.com/v1` |
  | `ollama()` | `ollama` | `http://localhost:11434/v1` |

All adapters stream over `fetch` (Node 20+), with no vendor SDK. Their shared behaviour:

- **Keys** come only from the options you pass. Every credential header value (the key, the bearer token, and custom headers such as `api-key`) is replaced with `[REDACTED]` in error messages and `details`, even when a server echoes it back in its error body. Values shorter than 8 characters are not treated as secrets.
- **Tool calls:** tools are sent with the `strict` flag where the API has one (OpenAI-compatible `strict: true`, `aigent_multi` with `strict: false`). Strict decoding is a request, not a guarantee: OpenAI does not guarantee schema conformance for parallel tool calls unless `parallel_tool_calls` is false, and DeepSeek honours `strict` only on its `/beta` base URL. The loop validates every call's arguments against the tool schema either way. Malformed tool-call JSON from the model reaches the loop as the raw string, so the model gets a precise validation error it can fix.
- **Failures:** HTTP errors become `provider_failed` errors with `details.status` and `details.retryable` (true for 408, 409, 429 and 5xx), and the message includes the server's own reason when the body has one. Dropped connections and streams cut off before their final event are `provider_failed` with `details.retryable: true` and no `status`. A 2xx response that is not `text/event-stream` fails with its content type and body. The run then ends with status `failed`. Stopping a run aborts the HTTP request and cancels the response body.
- **Usage:** a `usage` event is emitted only when the server reports usage; it is left out, never reported as zeros, when the server sends none.
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
  // first `stream` call, e.g. with a fake `fetch`.
  create: scenario => myProvider({ fetch: fakeFetchFor(scenario) }),
  // Lets the suite check the response body is cancelled on abort and early break.
  observe: () => ({ isBodyCancelled: lastFakeBodyWasCancelled() }),
  skip: [], // scenario kinds that cannot apply to your provider
});
```

A wire-level fixture must stream tool arguments exactly as the scenario's `argumentFragments` / `rawArgsFragments` (one delta per fragment, calls interleaved), wait `delayMs` before each `slow-text` chunk, and deliver bodies in small byte chunks; `chunkBytes(text, size)` from the same entry does the last part.

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

Settings can be given at four levels. Each field is taken from the highest level that sets it: task, then agent, then `createAigent({ modelSettings })`, then `createAigent({ providerModelSettings: { [providerId]: ... } })`. `providerOptions` is the exception: it is shallow-merged across levels, higher levels winning per key.

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
| `maxOutputTokens` | positive integer | `max_tokens` | `max_tokens` (default `defaultMaxTokens`) |
| `temperature` | 0 to 2 | `temperature` | `temperature`, dropped while thinking is on (the API requires the default) |
| `topP` | 0 to 1 | `top_p` | `top_p` |
| `thinking` | `'off'`, `'on'`, `{ budgetTokens }` (at least 1024) | not supported | `'on'` uses a budget of `min(maxOutputTokens - 1, 8000)` (8000 when `maxOutputTokens` is unset, never below 1024) |
| `effort` | `'low'`, `'medium'`, `'high'`, `'max'` | `reasoning_effort` (`max` sends `high`), not sent when `thinking` is `'off'` | a thinking budget of 2048, 8000, 16000 or 32000 when `thinking` is unset |
| `promptCaching` | boolean | not supported | overrides the adapter's `promptCaching` option |
| `stop` | up to 4 non-empty strings | `stop` | `stop_sequences` |
| `seed` | non-negative integer | `seed` | not supported |
| `providerOptions` | object | merged into the request body last | merged into the request body last |
| `contextSize` | positive integer | runtime only, never sent | runtime only, never sent |
| `showThinking` | boolean (default true) | runtime only: `false` hides `thinking-delta` events | same |

With Anthropic thinking on, `max_tokens` must exceed the budget, so it is raised to the budget + 1024 when it would not.

Invalid values are rejected up front: agent, `createAigent` and per-provider settings throw `invalid_definition` naming each bad field, and task settings throw `invalid_input`. A setting the provider cannot honour is never sent. The run emits one `warning` event per such setting instead, for example `Provider 'deepseek' does not support setting 'thinking'; ignored`. A provider lists what it can map in `capabilities.supportedSettings`. It can also reject combinations through `unsupportedSettings(settings)`, such as Anthropic's `temperature` with thinking on.

### Agent versions

Every agent has an `agentVersion`: a sha-256 of everything that shapes its behaviour. That covers the model, persona, skillset, context, effective settings (agent, runtime and provider levels), limits, the definition's `version` label, each tool's contract (name, description, schema and flags) and the library version. It does not depend on `name` or `instanceId`, or on key order. Each run record in the `runs` collection stores `agentVersion`, `model`, the resolved `settings` and the `version` label, so results can be compared across agent revisions.

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
- `toolCallsPerTurn`: `toolCalls / turns`, or 0 when no request was made. Every turn re-sends the conversation, so doing the same work in fewer turns is more efficient. For example, 50 tool calls in 3 turns gives about 16.7. Batch tools and `aigent_multi` raise this number.

## Stream directives

The model may emit single-line directives anywhere in its reply, each on its own line starting with `::aigent`. They are parsed as the tokens arrive (chunk-boundary safe), removed from the visible `text-delta` stream and published as `directive` events:

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

Roadmap (later slices, each with its own spec): model settings (thinking and effort), retry and fallback, vision, chat sessions, efficiency scoring and `report()`, tool-result cache, context compaction and layout, built-in tool packs (filesystem, code intelligence, web and more), an optimisation phase, then learning (memory first, then prompt/strategy tuning and reusable skills), plus resume, guardrails, scheduler and approvals.

## License

MIT
