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
- Keyed per-agent write queue and the `Store` contract with an in-memory store
- Stream directive parser, task input validation, system prompt and task brief
- `FakeProvider` test helpers (`@anupheaus/aigent/testing`)

Roadmap (later slices, each with its own spec): real provider adapters (Anthropic and OpenAI-compatible, covering DeepSeek, OpenAI and Ollama), chat sessions, efficiency scoring and `report()`, tool-result cache, context compaction and layout, built-in tool packs (filesystem, code intelligence, web and more), an optimisation phase, then learning (memory first, then prompt/strategy tuning and reusable skills), plus resume, guardrails, scheduler and approvals.

## License

MIT
