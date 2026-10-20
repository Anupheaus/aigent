import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PREFIX_CHANGED_WARNING } from '../context/stability-monitor.js';
import type { PlanItem } from '../planning/plan-schema.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { ProviderEvent, ToolCall } from '../providers/provider-types.js';
import { defineTool } from '../tools/define-tool.js';
import type { AgentDefinition } from './agent-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const PLAN: PlanItem[] = [
  { id: 'p1', label: 'Find', description: 'Find the theme file', acceptanceCriteria: ['Path reported'] },
  { id: 'p2', label: 'Explain', description: 'Explain how it works', acceptanceCriteria: ['Two sentences'] },
];
const USAGE: ProviderEvent = { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };

function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

/** A turn that streams text (directive lines included) and then makes tool calls, in that order unless `callsFirst`. */
function mixedTurn(params: { text: string; calls: ToolCall[]; callsFirst?: boolean }): FakeTurn {
  const { text, calls, callsFirst = false } = params;
  const textEvents: ProviderEvent[] = [{ type: 'text-delta', text }];
  const callEvents: ProviderEvent[] = calls.map(call => ({ type: 'tool-call', call }));
  return { events: [...(callsFirst ? [...callEvents, ...textEvents] : [...textEvents, ...callEvents]), USAGE, { type: 'done', finishReason: 'tool_calls' }] };
}

const echo = defineTool({
  name: 'echo', description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'echo' }), run: async ({ text }) => text,
});

function setup(params: { turns: FakeTurn[]; definition?: Partial<AgentDefinition>; options?: Partial<AigentOptions> }) {
  const { turns, definition = {}, options = {} } = params;
  const provider = createFakeProvider({ turns });
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, enableFeedback: false, ...options });
  const agent = ai.agent({ name: 'planner', model: 'fake:m', tools: [echo], ...definition });
  return { agent, provider, store };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function complete(updates: { id: string; status: string; evidence?: string }[], id = 'pc'): ToolCall {
  return { id, name: 'plan_complete', args: { updates } };
}

describe('createAigent plan', () => {
  it('pins the plan definitions once after the brief, keeps them stable, and shows statuses only in the volatile block', async () => {
    const { agent, provider } = setup({ turns: [
      toolTurn([complete([{ id: 'p1', status: 'done', evidence: 'src/theme.ts' }])]),
      toolTurn([complete([{ id: 'p2', status: 'done', evidence: 'explained' }], 'pc2')]),
      textTurn('All done'),
    ] });
    const run = agent.task({ task: 'Explain the theme', plan: PLAN });
    const events = await collect(run);
    const result = await run;
    const { requests } = provider;
    expect(requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_multi', 'echo', 'plan_complete', 'todo']);
    for (const request of requests) {
      expect(request.messages[2]).toEqual({ role: 'user', text: expect.stringMatching(/^# Plan\n/) });
      expect(request.messages[2]).toEqual(requests[0]?.messages[2]);
      expect(request.messages.filter(({ text }) => text?.startsWith('# Plan'))).toHaveLength(1);
      expect(request.messages[2]?.text).not.toMatch(/: (pending|in_progress|done|blocked)$/m);
    }
    expect(requests[0]?.messages.at(-1)?.text).toContain('## Plan status\n- p1: pending\n- p2: pending');
    expect(requests[1]?.messages.at(-1)?.text).toContain('## Plan status\n- p1: done\n- p2: pending');
    expect(events.filter(({ type }) => type === 'plan-update')).toEqual([
      { type: 'plan-update', changed: ['p1'], items: [expect.objectContaining({ id: 'p1', status: 'done', evidence: 'src/theme.ts' }), expect.objectContaining({ id: 'p2', status: 'pending' })] },
      { type: 'plan-update', changed: ['p2'], items: [expect.objectContaining({ status: 'done' }), expect.objectContaining({ status: 'done' })] },
    ]);
    expect(events.filter(event => event.type === 'warning' && event.message === PREFIX_CHANGED_WARNING)).toEqual([]);
    expect(result).toMatchObject({ status: 'completed', plan: [{ id: 'p1', status: 'done' }, { id: 'p2', status: 'done' }] });
  });

  it('ends incomplete when a plan item is not done, and stores plan and todo on the run record', async () => {
    const { agent, store } = setup({ turns: [
      toolTurn([complete([{ id: 'p1', status: 'done', evidence: 'found' }]), { id: 't', name: 'todo', args: { ops: [{ op: 'add', label: 'Check docs' }] } }]),
      textTurn('Stopping here'),
    ] });
    const result = await agent.task({ task: 'x', plan: PLAN, unattended: true });
    expect(result.status).toBe('incomplete');
    expect(result.todo).toEqual([{ id: 't1', label: 'Check docs', status: 'pending' }]);
    const record = (await store.get<RunRecord>('runs', result.runId))!.value;
    expect(record).toMatchObject({ status: 'incomplete', plan: [{ id: 'p1', status: 'done', label: 'Find' }, { id: 'p2', status: 'pending' }], todo: [{ id: 't1', status: 'pending', label: 'Check docs' }] });
  });

  it('keeps only ids and statuses on the run record when content capture is off', async () => {
    const { agent, store } = setup({ options: { captureContent: false }, turns: [textTurn('done')] });
    const result = await agent.task({ task: 'x', plan: PLAN });
    expect((await store.get<RunRecord>('runs', result.runId))!.value.plan).toEqual([{ id: 'p1', status: 'pending' }, { id: 'p2', status: 'pending' }]);
  });

  it('returns a per-update envelope: valid updates apply, invalid ones fail precisely and reach TaskResult.errors', async () => {
    const { agent, provider } = setup({ turns: [
      toolTurn([complete([{ id: 'p1', status: 'in_progress' }, { id: 'zz', status: 'done', evidence: 'x' }, { id: 'p2', status: 'done' }])]),
      textTurn('ok'),
    ] });
    const result = await agent.task({ task: 'x', plan: PLAN });
    const message = provider.requests[1]!.messages.find(({ role }) => role === 'tool');
    expect(JSON.parse(message!.text!).result).toEqual([
      { index: 0, ok: true, result: { id: 'p1', changed: true } },
      { index: 1, ok: false, error: expect.objectContaining({ code: 'unknown_plan_item', suggestion: 'Valid plan item ids: p1, p2' }) },
      { index: 2, ok: false, error: expect.objectContaining({ code: 'evidence_required' }) },
    ]);
    expect(result.errors.map(({ code }) => code)).toEqual(['unknown_plan_item', 'evidence_required']);
  });

  it('applies a directive and a tool call of the same turn in arrival order, either way round', async () => {
    const directive = '::aigent plan {"updates":[{"id":"p1","status":"in_progress"}]}\n';
    const doneCall = complete([{ id: 'p1', status: 'done', evidence: 'found it' }]);
    const directiveFirst = setup({ turns: [mixedTurn({ text: directive, calls: [doneCall] }), textTurn('ok')] });
    expect((await directiveFirst.agent.task({ task: 'x', plan: PLAN })).plan?.[0]?.status).toBe('done');
    const callFirst = setup({ turns: [mixedTurn({ text: directive, calls: [doneCall], callsFirst: true }), textTurn('ok')] });
    const run = callFirst.agent.task({ task: 'x', plan: PLAN });
    const events = await collect(run);
    expect((await run).plan?.[0]?.status).toBe('done');
    // The directive then tried to move p1 back without evidence: rejected, with a warning and a correction next turn.
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining("Directive 'plan' entry 0 was rejected (status_regression)") });
    expect(callFirst.provider.requests[1]?.messages.at(-1)?.text).toMatch(/## Corrections\n- ::aigent plan entry 0 was rejected \(status_regression\)/);
  });

  it('registers plan_complete only with a plan, and todo unless the agent opts out', async () => {
    const plain = setup({ turns: [textTurn('ok')] });
    await plain.agent.task({ task: 'x' });
    expect(plain.provider.requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_multi', 'echo', 'todo']);
    expect(plain.provider.requests[0]?.messages.map(({ role }) => role)).toEqual(['system', 'user', 'user']);
    const noTodo = setup({ definition: { todo: false }, turns: [textTurn('ok')] });
    await noTodo.agent.task({ task: 'x' });
    expect(noTodo.provider.requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_multi', 'echo']);
  });
});

describe('createAigent todo', () => {
  // Replaced (review I4): the old test locked in rewriting the pinned message (index 2) on every todo add/edit/delete,
  // which shifted every later message and lost the provider cache from message 2 on each turn.
  it('keeps todo items (definitions and statuses) in the volatile block, so todo changes never touch the prefix', async () => {
    const { agent, provider } = setup({ turns: [
      toolTurn([{ id: 'a', name: 'todo', args: { ops: [{ op: 'add', label: 'Read' }, { op: 'add', label: 'Write' }] } }]),
      toolTurn([{ id: 'b', name: 'todo', args: { ops: [{ op: 'set_status', id: 't1', status: 'done' }] } }]),
      mixedTurn({ text: '::aigent todo {"ops":[{"op":"delete","id":"t2"}]}\n', calls: [{ id: 'c', name: 'echo', args: { text: 'x' } }] }),
      textTurn('ok'),
    ] });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    const { requests } = provider;
    expect(requests[0]?.messages.map(({ role }) => role)).toEqual(['system', 'user', 'user']);
    // Every request's stored history (all but the trailing volatile block) starts with the previous request's.
    requests.slice(1).forEach((request, index) => {
      const previous = requests[index]!.messages.slice(0, -1);
      expect(request.messages.slice(0, previous.length)).toEqual(previous);
    });
    expect(requests[1]?.messages.at(-1)?.text).toContain('## Todo\nYour own list; change it with the todo tool or an ::aigent todo directive.\n- t1 [pending]: Read\n- t2 [pending]: Write');
    expect(requests[2]?.messages.at(-1)?.text).toContain('- t1 [done]: Read\n- t2 [pending]: Write');
    expect(requests[3]?.messages.at(-1)?.text).not.toContain('t2');
    expect(events.filter(({ type }) => type === 'todo-update').map(event => (event.type === 'todo-update' ? event.changed : []))).toEqual([['t1', 't2'], ['t1'], ['t2']]);
    expect(events.filter(event => event.type === 'warning')).toEqual([]);
    // The only item left (t1) is done.
    expect((await run).status).toBe('completed');
  });
});
