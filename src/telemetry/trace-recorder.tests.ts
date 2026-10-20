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

describe('createTraceRecorder outcomes', () => {
  function recorderWithSteps(captureContent = true) {
    const recorder = createTraceRecorder({ now: () => 0, captureContent, nonOutcomeTools: ['aigent_feedback'] });
    const begin = (turn: number, callId: string, extra: { tool?: string; parentCallId?: string } = {}) => recorder.begin({ turn, callId, tool: extra.tool ?? 'search', args: {}, ...(extra.parentCallId == null ? {} : { parentCallId: extra.parentCallId }) });
    return { recorder, begin };
  }

  it('attaches an outcome to the last top-level step started before the report', () => {
    const { recorder, begin } = recorderWithSteps();
    begin(1, 'a');
    begin(1, 'm', { tool: 'aigent_multi' });
    begin(1, 'inner', { parentCallId: 'm' });
    begin(1, 'f', { tool: 'aigent_feedback' });
    recorder.attachOutcome({ outcome: { success: true, answer: 'found' }, source: 'directive' });
    begin(2, 'b');
    recorder.attachOutcome({ outcome: { success: false, answer: 'not there' }, source: 'previous', beforeIndex: 0 });
    expect(recorder.steps().map(({ callId, outcome }) => ({ callId, outcome }))).toEqual([
      { callId: 'a', outcome: undefined },
      { callId: 'm', outcome: { success: true, answer: 'found', source: 'directive' } },
      { callId: 'inner', outcome: undefined },
      { callId: 'f', outcome: undefined },
      { callId: 'b', outcome: undefined },
    ]);
  });

  it('uses start order within a parallel turn: a report before call c attaches to b, its predecessor', () => {
    const { recorder, begin } = recorderWithSteps();
    begin(1, 'a');
    begin(1, 'b');
    begin(2, 'c');
    begin(2, 'd');
    recorder.attachOutcome({ outcome: { success: true, answer: 'b worked' }, source: 'previous', beforeIndex: 2 });
    recorder.attachOutcome({ outcome: { success: true, answer: 'c worked' }, source: 'previous', beforeIndex: 3 });
    expect(recorder.steps().map(({ outcome }) => outcome?.answer)).toEqual([undefined, 'b worked', 'c worked', undefined]);
  });

  it('keeps one outcome per step and lets a directive win over previous, whichever came first', () => {
    const { recorder, begin } = recorderWithSteps();
    begin(1, 'a');
    begin(2, 'b');
    recorder.attachOutcome({ outcome: { success: false, answer: 'from previous' }, source: 'previous', beforeIndex: 1 });
    recorder.attachOutcome({ outcome: { success: true, answer: 'from directive' }, source: 'directive', beforeIndex: 1 });
    recorder.attachOutcome({ outcome: { success: false, answer: 'late previous' }, source: 'previous', beforeIndex: 1 });
    expect(recorder.steps()[0]?.outcome).toEqual({ success: true, answer: 'from directive', source: 'directive' });
  });

  it('ignores a report with no step before it, and stores no answer text without content capture', () => {
    const { recorder, begin } = recorderWithSteps(false);
    recorder.attachOutcome({ outcome: { success: true, answer: 'nothing yet' }, source: 'directive' });
    begin(1, 'a');
    recorder.attachOutcome({ outcome: { success: true, answer: 'secret path' }, source: 'directive' });
    expect(recorder.steps()[0]?.outcome).toEqual({ success: true, answer: '', source: 'directive' });
  });

  it('names the step a report before a given index would attach to, and whether it already has an outcome', () => {
    const { recorder, begin } = recorderWithSteps();
    expect(recorder.outcomeTarget(0)).toBeUndefined();
    begin(1, 'a');
    begin(1, 'f', { tool: 'aigent_feedback' });
    expect(recorder.outcomeTarget(2)).toEqual({ index: 0, turn: 1, hasOutcome: false });
    recorder.attachOutcome({ outcome: { success: true, answer: 'x' }, source: 'directive' });
    expect(recorder.outcomeTarget(2)).toEqual({ index: 0, turn: 1, hasOutcome: true });
  });
});
