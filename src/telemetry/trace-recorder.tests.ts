import { describe, expect, it } from 'vitest';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { createTraceRecorder } from './trace-recorder.js';

function fakeClock(start: number) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

function succeeded(callId: string, overrides: Partial<ExecutedToolCall> = {}): ExecutedToolCall {
  return {
    envelope: { id: callId, tool: 't', ok: true, result: 'r' },
    outcome: { success: true, reason: 'completed' },
    durationMs: 5,
    size: { resultBytes: 3, resultTokens: 1, truncated: false },
    nested: [],
    ...overrides,
  };
}

describe('createTraceRecorder', () => {
  it('orders steps by start, with turns, start times and finished timings', () => {
    const clock = fakeClock(1_000);
    const recorder = createTraceRecorder({ now: clock.now, captureContent: true });
    const finishA = recorder.begin({ turn: 1, callId: 'a', tool: 'search', args: { query: 'x' } });
    clock.advance(10);
    const finishB = recorder.begin({ turn: 1, callId: 'b', tool: 'read', args: { path: 'p' } });
    finishB(succeeded('b', { durationMs: 7 }));
    finishA(succeeded('a', { durationMs: 20 }));
    clock.advance(30);
    recorder.begin({ turn: 2, callId: 'c', tool: 'read', args: {} })(succeeded('c'));
    expect(recorder.steps()).toEqual([
      { index: 0, turn: 1, callId: 'a', tool: 'search', argsSummary: '{"query":"x"}', args: { query: 'x' }, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 20, startedAtMs: 1_000 },
      { index: 1, turn: 1, callId: 'b', tool: 'read', argsSummary: '{"path":"p"}', args: { path: 'p' }, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 7, startedAtMs: 1_010 },
      { index: 2, turn: 2, callId: 'c', tool: 'read', argsSummary: '{}', args: {}, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 5, startedAtMs: 1_040 },
    ]);
  });

  it('links inner calls to their parent and records failures, batch item counts and truncation', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true });
    recorder.begin({ turn: 1, callId: 'm', tool: 'aigent_multi', args: { calls: [] } })(succeeded('m'));
    recorder.begin({ turn: 1, callId: 'x', parentCallId: 'm', tool: 'read_all', args: { items: [] } })(succeeded('x', { items: { total: 3, failed: 1 }, size: { resultBytes: 900, resultTokens: 225, truncated: true } }));
    recorder.begin({ turn: 1, callId: 'y', parentCallId: 'm', tool: 'echo', args: {} })({
      ...succeeded('y'),
      envelope: { id: 'y', tool: 'echo', ok: false, error: { category: 'validation', code: 'invalid_arguments', message: 'bad', retryable: true } },
    });
    const [, batch, failed] = recorder.steps();
    expect(batch).toMatchObject({ parentCallId: 'm', itemFailures: 1, itemTotal: 3, resultBytes: 900, resultTokens: 225, truncated: true, ok: true });
    expect(failed).toMatchObject({ parentCallId: 'm', ok: false, errorCategory: 'validation', errorCode: 'invalid_arguments' });
  });

  it('keeps no argument values when content capture is off', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: false });
    recorder.begin({ turn: 1, callId: 'a', tool: 'read', args: { path: '/secret/file', depth: 2, deep: { flag: true, list: ['x'] }, empty: null } })(succeeded('a'));
    const [step] = recorder.steps();
    expect(step).not.toHaveProperty('args');
    expect(step?.argsSummary).toBe('{"deep":{"flag":"<boolean>","list":["<string>"]},"depth":"<number>","empty":null,"path":"<string>"}');
    expect(JSON.stringify(step)).not.toContain('secret');
  });

  it('cuts the argument summary to 120 characters of canonical JSON', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true });
    recorder.begin({ turn: 1, callId: 'a', tool: 'write', args: { text: 'x'.repeat(500), a: 1 } })(succeeded('a'));
    expect(recorder.steps()[0]?.argsSummary).toBe(`{"a":1,"text":"${'x'.repeat(105)}`);
  });

  it('reports a step that never finished as aborted, and ignores a second finish', () => {
    const clock = fakeClock(0);
    const recorder = createTraceRecorder({ now: clock.now, captureContent: true });
    recorder.begin({ turn: 1, callId: 'hung', tool: 'slow', args: {} });
    const finish = recorder.begin({ turn: 1, callId: 'done', tool: 'fast', args: {} });
    finish(succeeded('done', { durationMs: 1 }));
    finish(succeeded('done', { durationMs: 99 }));
    clock.advance(50);
    expect(recorder.steps()).toEqual([
      expect.objectContaining({ callId: 'hung', ok: false, errorCategory: 'aborted', errorCode: 'step_unfinished', durationMs: 50 }),
      expect.objectContaining({ callId: 'done', ok: true, durationMs: 1 }),
    ]);
  });

  it('returns copies, so callers cannot change what was recorded', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true });
    const args = { path: 'a' };
    recorder.begin({ turn: 1, callId: 'a', tool: 'read', args })(succeeded('a'));
    args.path = 'changed';
    const [first] = recorder.steps();
    if (first != null) first.tool = 'mutated';
    expect(recorder.steps()[0]).toMatchObject({ tool: 'read', args: { path: 'a' } });
  });
});
