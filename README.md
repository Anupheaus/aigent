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
- `FakeProvider` test helpers (`@anupheaus/aigent/testing`)

Roadmap (later slices, each with its own spec): real provider adapters (Anthropic and OpenAI-compatible, covering DeepSeek, OpenAI and Ollama), chat sessions, efficiency scoring and `report()`, tool-result cache, context compaction and layout, built-in tool packs (filesystem, code intelligence, web and more), an optimisation phase, then learning (memory first, then prompt/strategy tuning and reusable skills), plus resume, guardrails, scheduler and approvals.

## License

MIT
