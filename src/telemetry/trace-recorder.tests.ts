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
    const recorder = createTraceRecorder({ now: clock.now, captureContent: true, argsDigestKey: 'run_1' });
    const finishA = recorder.begin({ turn: 1, callId: 'a', tool: 'search', args: { query: 'x' } });
    clock.advance(10);
    const finishB = recorder.begin({ turn: 1, callId: 'b', tool: 'read', args: { path: 'p' } });
    finishB(succeeded('b', { durationMs: 7 }));
    finishA(succeeded('a', { durationMs: 20 }));
    clock.advance(30);
    recorder.begin({ turn: 2, callId: 'c', tool: 'read', args: {} })(succeeded('c'));
    expect(recorder.steps()).toEqual([
      { index: 0, turn: 1, callId: 'a', tool: 'search', argsSummary: '{"query":"x"}', argsHash: expect.any(String), args: { query: 'x' }, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 20, startedAtMs: 1_000 },
      { index: 1, turn: 1, callId: 'b', tool: 'read', argsSummary: '{"path":"p"}', argsHash: expect.any(String), args: { path: 'p' }, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 7, startedAtMs: 1_010 },
      { index: 2, turn: 2, callId: 'c', tool: 'read', argsSummary: '{}', argsHash: expect.any(String), args: {}, ok: true, resultBytes: 3, resultTokens: 1, truncated: false, durationMs: 5, startedAtMs: 1_040 },
    ]);
  });

  it('links inner calls to their parent and records failures, batch item counts and truncation', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true, argsDigestKey: 'run_1' });
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
    const recorder = createTraceRecorder({ now: () => 0, captureContent: false, argsDigestKey: 'run_1' });
    recorder.begin({ turn: 1, callId: 'a', tool: 'read', args: { path: '/secret/file', depth: 2, deep: { flag: true, list: ['x'] }, empty: null } })(succeeded('a'));
    const [step] = recorder.steps();
    expect(step).not.toHaveProperty('args');
    expect(step?.argsSummary).toBe('{"deep":{"flag":"<boolean>","list":["<string>"]},"depth":"<number>","empty":null,"path":"<string>"}');
    expect(JSON.stringify(step)).not.toContain('secret');
  });

  it('digests the full arguments without their content, so values (not shapes) decide whether two calls match', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: false, argsDigestKey: 'run_1' });
    for (const [callId, path] of [['a', '/secret/a.txt'], ['b', '/secret/b.txt'], ['c', '/secret/a.txt']] as const) recorder.begin({ turn: 1, callId, tool: 'read', args: { path } })(succeeded(callId));
    const [first, second, third] = recorder.steps().map(({ argsHash }) => argsHash);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    expect(third).toBe(first);
    expect(JSON.stringify(recorder.steps())).not.toContain('secret');
  });

  it('digests long arguments in full, so a shared 120-character prefix is not a match', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true, argsDigestKey: 'run_1' });
    recorder.begin({ turn: 1, callId: 'a', tool: 'write', args: { text: `${'x'.repeat(200)}1` } })(succeeded('a'));
    recorder.begin({ turn: 1, callId: 'b', tool: 'write', args: { text: `${'x'.repeat(200)}2` } })(succeeded('b'));
    const [first, second] = recorder.steps();
    expect(first?.argsSummary).toBe(second?.argsSummary);
    expect(first?.argsHash).not.toBe(second?.argsHash);
  });

  it('salts digests per run, so the same arguments digest differently in another run', () => {
    const digestIn = (argsDigestKey: string) => {
      const recorder = createTraceRecorder({ now: () => 0, captureContent: false, argsDigestKey });
      recorder.begin({ turn: 1, callId: 'a', tool: 'read', args: { path: 'a.txt' } })(succeeded('a'));
      return recorder.steps()[0]?.argsHash;
    };
    expect(digestIn('run_1')).not.toBe(digestIn('run_2'));
  });

  it('cuts the argument summary to 120 characters of canonical JSON', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true, argsDigestKey: 'run_1' });
    recorder.begin({ turn: 1, callId: 'a', tool: 'write', args: { text: 'x'.repeat(500), a: 1 } })(succeeded('a'));
    expect(recorder.steps()[0]?.argsSummary).toBe(`{"a":1,"text":"${'x'.repeat(105)}`);
  });

  it('reports a step that never finished as aborted, and ignores a second finish', () => {
    const clock = fakeClock(0);
    const recorder = createTraceRecorder({ now: clock.now, captureContent: true, argsDigestKey: 'run_1' });
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
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true, argsDigestKey: 'run_1' });
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
    const recorder = createTraceRecorder({ now: () => 0, captureContent, nonOutcomeTools: ['aigent_feedback'], argsDigestKey: 'run_1' });
    const begin = (turn: number, callId: string, extra: { tool?: string; parentCallId?: string } = {}) => recorder.begin({ turn, callId, tool: extra.tool ?? 'search', args: {}, ...(extra.parentCallId == null ? {} : { parentCallId: extra.parentCallId }) });
    const answers = () => recorder.steps().map(({ callId, outcome }) => [callId, outcome?.answer]);
    return { recorder, begin, answers };
  }

  it('attaches a report to the last top-level work step of an earlier turn, skipping inner calls and commentary', () => {
    const { recorder, begin } = recorderWithSteps();
    begin(1, 'a');
    begin(1, 'm', { tool: 'aigent_multi' });
    begin(1, 'inner', { parentCallId: 'm' });
    begin(1, 'f', { tool: 'aigent_feedback' });
    begin(2, 'b');
    recorder.attachOutcome({ outcome: { success: true, answer: 'found' }, source: 'directive', turn: 2 });
    expect(recorder.steps().map(({ callId, outcome }) => ({ callId, outcome }))).toEqual([
      { callId: 'a', outcome: undefined },
      { callId: 'm', outcome: { success: true, answer: 'found', source: 'directive' } },
      { callId: 'inner', outcome: undefined },
      { callId: 'f', outcome: undefined },
      { callId: 'b', outcome: undefined },
    ]);
  });

  it('never attaches a report to a step of its own turn, whose result the model has not seen', () => {
    const { recorder, begin, answers } = recorderWithSteps();
    begin(1, 'a');
    begin(2, 'b');
    begin(2, 'c');
    recorder.attachOutcome({ outcome: { success: true, answer: 'a worked' }, source: 'previous', turn: 2 });
    recorder.attachOutcome({ outcome: { success: false, answer: 'from c' }, source: 'previous', turn: 2 });
    expect(answers()).toEqual([['a', 'a worked'], ['b', undefined], ['c', undefined]]);
  });

  it('keeps the first previous report on a step and ignores later ones from parallel calls', () => {
    const { recorder, begin, answers } = recorderWithSteps();
    begin(1, 'a');
    begin(1, 'b');
    recorder.attachOutcome({ outcome: { success: true, answer: 'first' }, source: 'previous', turn: 2 });
    recorder.attachOutcome({ outcome: { success: false, answer: 'second' }, source: 'previous', turn: 2 });
    expect(answers()).toEqual([['a', undefined], ['b', 'first']]);
  });

  it('ignores a report from the first turn, which has no earlier step', () => {
    const { recorder, begin, answers } = recorderWithSteps();
    begin(1, 'a');
    recorder.attachOutcome({ outcome: { success: true, answer: 'too soon' }, source: 'directive', turn: 1 });
    expect(answers()).toEqual([['a', undefined]]);
  });

  it('keeps one outcome per step and lets a directive win over previous, whichever came first', () => {
    const { recorder, begin } = recorderWithSteps();
    begin(1, 'a');
    begin(2, 'b');
    recorder.attachOutcome({ outcome: { success: false, answer: 'from previous' }, source: 'previous', turn: 2 });
    recorder.attachOutcome({ outcome: { success: true, answer: 'from directive' }, source: 'directive', turn: 2 });
    recorder.attachOutcome({ outcome: { success: false, answer: 'late previous' }, source: 'previous', turn: 2 });
    expect(recorder.steps()[0]?.outcome).toEqual({ success: true, answer: 'from directive', source: 'directive' });
  });

  it('stores no answer text without content capture', () => {
    const { recorder, begin } = recorderWithSteps(false);
    begin(1, 'a');
    recorder.attachOutcome({ outcome: { success: true, answer: 'secret path' }, source: 'directive', turn: 2 });
    expect(recorder.steps()[0]?.outcome).toEqual({ success: true, answer: '', source: 'directive' });
  });

  it('names the step a report from a given turn would attach to, and whether it already has an outcome', () => {
    const { recorder, begin } = recorderWithSteps();
    expect(recorder.outcomeTarget(1)).toBeUndefined();
    begin(1, 'a');
    begin(1, 'f', { tool: 'aigent_feedback' });
    expect(recorder.outcomeTarget(1)).toBeUndefined();
    expect(recorder.outcomeTarget(2)).toEqual({ index: 0, turn: 1, hasOutcome: false });
    recorder.attachOutcome({ outcome: { success: true, answer: 'x' }, source: 'directive', turn: 2 });
    expect(recorder.outcomeTarget(2)).toEqual({ index: 0, turn: 1, hasOutcome: true });
  });

  it('notes each call\'s memory saves on its top-level step, whenever they finish', () => {
    const recorder = createTraceRecorder({ now: () => 0, captureContent: true, argsDigestKey: 'run_1' });
    recorder.noteMemory({ callId: 'a', saved: 2, rejected: 1 });
    recorder.begin({ turn: 1, callId: 'a', tool: 'read', args: {} })(succeeded('a'));
    recorder.begin({ turn: 1, callId: 'a', parentCallId: 'm', tool: 'read', args: {} })(succeeded('a'));
    recorder.begin({ turn: 1, callId: 'b', tool: 'read', args: {} })(succeeded('b'));
    recorder.noteMemory({ callId: 'b', saved: 1, rejected: 0 });
    expect(recorder.steps().map(({ callId, parentCallId, memory }) => ({ callId, parentCallId, memory }))).toEqual([
      { callId: 'a', parentCallId: undefined, memory: { saved: 2, rejected: 1 } },
      { callId: 'a', parentCallId: 'm', memory: undefined },
      { callId: 'b', parentCallId: undefined, memory: { saved: 1, rejected: 0 } },
    ]);
  });

  it('keeps result leaves and hashes only when asked and with content capture on', () => {
    const result = { matches: [{ path: 'src/a.ts' }] };
    const run = (params: { captureContent: boolean; captureResults?: boolean }) => {
      const recorder = createTraceRecorder({ now: () => 0, argsDigestKey: 'run_1', ...params });
      recorder.begin({ turn: 1, callId: 'a', tool: 'search', args: {} })(succeeded('a', { envelope: { id: 'a', tool: 'search', ok: true, result } }));
      return recorder.steps()[0];
    };
    expect(run({ captureContent: true, captureResults: true })).toMatchObject({ resultLeaves: [{ path: '/matches/0/path', value: 'src/a.ts' }], resultHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(run({ captureContent: false, captureResults: true })?.resultLeaves).toBeUndefined();
    expect(run({ captureContent: true })?.resultLeaves).toBeUndefined();
  });
});
