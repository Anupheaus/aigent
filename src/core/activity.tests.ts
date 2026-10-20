import { describe, expect, it } from 'vitest';
import { createFakeTime, flush } from '../scheduler/fake-time.test-support.js';
import { createActivityPublisher } from './activity.js';
import type { ActivityUpdate } from './activity-update.js';

function setup(options: { throttleMs?: number; heartbeatMs?: number } = {}) {
  const time = createFakeTime(1_000);
  const updates: ActivityUpdate[] = [];
  const publisher = createActivityPublisher({
    runId: 'run_1', messageId: 'm1', clock: time.clock, sleep: time.sleep, options, maxTurns: 5, criteriaTotal: 2,
    price: usage => usage.outputTokens / 1_000, publish: update => updates.push(update),
  });
  return { time, updates, publisher };
}

describe('createActivityPublisher', () => {
  it('starts thinking, derives phases and status text from loop events, and ends with the terminal phase', async () => {
    const { time, updates, publisher } = setup({ throttleMs: 0 });
    publisher.observe({ type: 'tool-call', callId: 'c1', name: 'read_file', args: {} });
    publisher.observe({ type: 'tool-activity', callId: 'c1', view: { title: 'Reading 3 files', progress: { done: 1, total: 3 } } });
    publisher.observe({ type: 'tool-result', callId: 'c1', envelope: { id: 'c1', tool: 'read_file', ok: true, result: 'x' } });
    publisher.observe({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 0 } });
    publisher.observe({ type: 'directive', directive: { type: 'status', data: { text: 'Checking the answer' } } });
    publisher.observe({ type: 'text-delta', text: 'Hi' });
    publisher.finish('completed');
    await time.advance(10_000);
    expect(updates.map(({ phase, statusText }) => [phase, statusText])).toEqual([
      ['thinking', 'Thinking'], ['calling_tools', 'Running read_file'], ['calling_tools', 'Reading 3 files'], ['thinking', 'Thinking'], ['thinking', 'Thinking'],
      ['thinking', 'Checking the answer'], ['writing', 'Writing'], ['done', 'Done'],
    ]);
    expect(updates.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(updates[2]).toMatchObject({ runId: 'run_1', messageId: 'm1', current: [{ tool: 'read_file', callId: 'c1', startedAt: 1_000, itemsDone: 1, itemsTotal: 3 }] });
    expect(updates.at(-1)).toMatchObject({ heartbeat: false, tokens: { input: 10, output: 4 }, costUsd: 0.004, progress: { turn: 1, maxTurns: 5, criteriaTotal: 2 } });
    expect(time.pendingSleeps()).toBe(0);
  });

  it('throttles to one update per window with a trailing update, and never holds back the terminal one', async () => {
    const { time, updates, publisher } = setup({ throttleMs: 250 });
    publisher.observe({ type: 'tool-call', callId: 'a', name: 'x', args: {} });
    publisher.observe({ type: 'tool-call', callId: 'b', name: 'y', args: {} });
    await flush();
    expect(updates).toHaveLength(1);
    await time.advance(250);
    expect(updates.map(({ statusText }) => statusText)).toEqual(['Thinking', 'Running 2 tools']);
    expect(updates[1]?.elapsedMs).toBe(250);
    publisher.observe({ type: 'tool-result', callId: 'a', envelope: { id: 'a', tool: 'x', ok: true, result: 1 } });
    publisher.finish('cancelled');
    await time.advance(1_000);
    expect(updates.map(({ phase }) => phase)).toEqual(['thinking', 'calling_tools', 'cancelled']);
  });

  it('sends heartbeats only while busy and none after the terminal update', async () => {
    const { time, updates, publisher } = setup({ heartbeatMs: 5_000 });
    await time.advance(12_000);
    expect(updates.filter(({ heartbeat }) => heartbeat).map(({ elapsedMs }) => elapsedMs)).toEqual([5_000, 10_000]);
    publisher.observe({ type: 'tool-call', callId: 'q', name: 'ask_user', args: {} });
    await time.advance(260);
    expect(updates.at(-1)?.phase).toBe('waiting_for_user');
    const waiting = updates.length;
    await time.advance(20_000);
    expect(updates).toHaveLength(waiting);
    publisher.finish('completed');
    await time.advance(20_000);
    expect(updates.at(-1)?.phase).toBe('done');
    expect(time.pendingSleeps()).toBe(0);
  });

  it('ignores events after the terminal update', async () => {
    const { updates, publisher } = setup({ throttleMs: 0 });
    publisher.finish('failed');
    publisher.observe({ type: 'text-delta', text: 'late' });
    publisher.finish('completed');
    expect(updates.map(({ phase }) => phase)).toEqual(['thinking', 'failed']);
  });
});
