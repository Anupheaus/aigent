import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { startToolActivity } from './run-tool-activity.js';
import type { ToolActivityEmission } from './run-tool-activity.js';
import type { ToolOutcome } from './tool-types.js';

const ARGS = z.object({}).strict();
const SIGNAL = new AbortController().signal;

describe('startToolActivity', () => {
  it('emits running then final views from an async generator using the outcome', async () => {
    const tool = defineTool({
      name: 't', description: 't', args: ARGS, deterministic: true, cache: false, run: async () => 1,
      describeActivity: async function* (_args, outcome) {
        yield { title: 'Working' };
        const { success, reason } = await outcome;
        yield { title: success ? 'Done' : 'Failed', detail: reason };
      },
    });
    const emitted: ToolActivityEmission[] = [];
    await startToolActivity({ tool, args: {}, callId: 'c1', outcome: Promise.resolve<ToolOutcome>({ success: true, reason: 'ok' }), signal: SIGNAL, emit: event => emitted.push(event) });
    expect(emitted).toEqual([
      { type: 'tool-activity', callId: 'c1', view: { title: 'Working' } },
      { type: 'tool-activity', callId: 'c1', view: { title: 'Done', detail: 'ok' } },
    ]);
  });

  it('stops waiting for a renderer promise that never settles once the activity signal aborts', async () => {
    const tool = defineTool({ name: 't', description: 't', args: ARGS, deterministic: true, cache: false, run: async () => 1, describeActivity: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const emitted: ToolActivityEmission[] = [];
    const activity = startToolActivity({ tool, args: {}, callId: 'c', outcome: Promise.resolve({ success: true, reason: '' }), signal: controller.signal, emit: event => emitted.push(event) });
    controller.abort();
    await activity;
    expect(emitted).toEqual([]);
  });

  it('stops iterating an async renderer once the activity signal aborts and emits nothing afterwards', async () => {
    let releaseSecondView: () => void = () => undefined;
    const tool = defineTool({
      name: 't', description: 't', args: ARGS, deterministic: true, cache: false, run: async () => 1,
      describeActivity: async function* () {
        yield { title: 'First' };
        await new Promise<void>(resolve => { releaseSecondView = resolve; });
        yield { title: 'Too late' };
      },
    });
    const controller = new AbortController();
    const emitted: ToolActivityEmission[] = [];
    const activity = startToolActivity({ tool, args: {}, callId: 'c', outcome: Promise.resolve({ success: true, reason: '' }), signal: controller.signal, emit: event => emitted.push(event) });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    controller.abort();
    await activity;
    releaseSecondView();
    await new Promise(resolve => setImmediate(resolve));
    expect(emitted).toEqual([{ type: 'tool-activity', callId: 'c', view: { title: 'First' } }]);
  });

  it('supports a plain object return', async () => {
    const tool = defineTool({ name: 't', description: 't', args: ARGS, deterministic: true, cache: false, run: async () => 1, describeActivity: () => ({ title: 'Static' }) });
    const emitted: ToolActivityEmission[] = [];
    await startToolActivity({ tool, args: {}, callId: 'c', outcome: Promise.resolve({ success: true, reason: '' }), signal: SIGNAL, emit: event => emitted.push(event) });
    expect(emitted).toEqual([{ type: 'tool-activity', callId: 'c', view: { title: 'Static' } }]);
  });

  it('turns a throwing renderer into a default view plus a warning and never rejects', async () => {
    const tool = defineTool({ name: 'boom_tool', description: 't', args: ARGS, deterministic: true, cache: false, run: async () => 1, describeActivity: () => { throw new Error('renderer broke'); } });
    const emitted: ToolActivityEmission[] = [];
    await startToolActivity({ tool, args: {}, callId: 'c', outcome: Promise.resolve({ success: true, reason: '' }), signal: SIGNAL, emit: event => emitted.push(event) });
    expect(emitted).toEqual([
      { type: 'warning', message: expect.stringContaining('renderer broke') },
      { type: 'tool-activity', callId: 'c', view: { title: 'boom_tool' } },
    ]);
  });
});
