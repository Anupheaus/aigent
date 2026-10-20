import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { ActivityUpdate } from './activity-update.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { ToolActivityEvent } from './run-callbacks.js';

const WRITE_MS = 60;

const echo = defineTool({
  name: 'echo', description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: args => ({ title: `Echoing ${args.text}` }), run: async ({ text }) => text,
});

const write = defineTool({
  name: 'write_note', description: 'Write a note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
  describeActivity: () => ({ title: 'Writing' }),
  run: async ({ text }, { signal }) => new Promise(resolve => { const timer = setTimeout(() => resolve(`wrote ${text}`), WRITE_MS); signal.addEventListener('abort', () => clearTimeout(timer)); }),
});

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function setup(turns: FakeTurn[], tools: Tool[] = [echo]) {
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], enableFeedback: false, activity: { throttleMs: 0 } });
  return { provider, agent: ai.agent({ name: 'a', model: 'fake:m', tools }) };
}

const THINKING: FakeTurn = { events: [{ type: 'thinking-delta', text: 'Hmm, ' }, { type: 'thinking-delta', text: 'echo it' }, ...toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }]).events] };

describe('task activity and callbacks', () => {
  it('emits activity derived from the loop, terminal update just before done, with no extra provider calls', async () => {
    const { agent, provider } = setup([toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }]), textTurn('Done.')]);
    const events = await collect(agent.task({ task: 'echo' }));
    expect(provider.requests).toHaveLength(2);
    const updates = events.flatMap(event => (event.type === 'activity' ? [event.update] : []));
    expect(updates[0]).toMatchObject({ seq: 1, phase: 'thinking', heartbeat: false });
    expect(updates.map(({ seq }) => seq)).toEqual(updates.map((_update, index) => index + 1));
    expect(updates.map(({ phase }) => phase)).toEqual(expect.arrayContaining(['calling_tools', 'writing', 'finishing']));
    expect(events.at(-2)).toEqual({ type: 'activity', update: expect.objectContaining({ phase: 'done', statusText: 'Done', progress: expect.objectContaining({ turn: 2 }) }) });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('closes each streamed reasoning with thinking-done and hands it to onThinking per turn', async () => {
    const { agent } = setup([THINKING, textTurn('ok')]);
    const run = agent.task({ task: 'think' });
    const thoughts: { turn: number; text: string }[] = [];
    const pending: Promise<void>[] = [];
    run.onThinking((thinking, { turn, runId }) => {
      expect(runId).toBe(run.runId);
      pending.push((async () => { let text = ''; for await (const delta of thinking) text += delta; thoughts.push({ turn, text }); })());
    });
    const events = await collect(run);
    await Promise.all(pending);
    expect(events.filter(({ type }) => type === 'thinking-done')).toEqual([{ type: 'thinking-done', text: 'Hmm, echo it' }]);
    const doneIndex = events.findIndex(({ type }) => type === 'thinking-done');
    expect(events[doneIndex + 1]?.type).toBe('tool-call');
    expect(thoughts).toEqual([{ turn: 1, text: 'Hmm, echo it' }]);
  });

  it('onActivity and onToolActivity see exactly the events, earlier ones included', async () => {
    const { agent } = setup([toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }]), textTurn('Done.')]);
    const run = agent.task({ task: 'echo' });
    const events = await collect(run);
    const updates: ActivityUpdate[] = [];
    const views: ToolActivityEvent[] = [];
    run.onActivity(update => updates.push(update));
    const unsubscribe = run.onToolActivity(event => views.push(event));
    await new Promise(resolve => setTimeout(resolve, 10));
    unsubscribe();
    expect(updates).toEqual(events.flatMap(event => (event.type === 'activity' ? [event.update] : [])));
    expect(views).toEqual(events.filter(event => event.type === 'tool-activity'));
  });

  it('lets a side-effecting tool finish after an immediate stop, unless forced', async () => {
    const call = { id: 'w1', name: 'write_note', args: { text: 'a' } };
    for (const force of [false, true]) {
      const { agent } = setup([toolTurn([call]), textTurn('never')], [write]);
      const run = agent.task({ task: 'write' });
      setTimeout(() => run.stop({ mode: 'immediate', force }), 10);
      const events = await collect(run);
      const result = events.find(event => event.type === 'tool-result');
      expect((await run).status).toBe('cancelled');
      expect(result).toMatchObject(force ? { envelope: { ok: false, error: { category: 'aborted' } } } : { envelope: { ok: true, result: 'wrote a' } });
    }
  });
});
