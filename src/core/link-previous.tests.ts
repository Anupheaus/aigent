import { describe, expect, it } from 'vitest';
import { createTraceRecorder } from '../telemetry/trace-recorder.js';
import type { AigentEvent } from './aigent-events.js';
import { linkPrevious } from './link-previous.js';
import type { RunFeedback } from './link-previous.js';

function setup() {
  const recorder = createTraceRecorder({ now: () => 0, captureContent: true });
  const feedback: RunFeedback = { isEnabled: true, hasWarnedMissing: false };
  const events: AigentEvent[] = [];
  const link = (callId: string, args: unknown, turn: number) => linkPrevious({ call: { id: callId, name: 'echo', args }, turn, recorder, feedback, emit: event => events.push(event) });
  return { recorder, feedback, events, link };
}

describe('linkPrevious', () => {
  it('returns the arguments without previous and records a reported outcome on the step before', () => {
    const { recorder, events, link } = setup();
    recorder.begin({ turn: 1, callId: 'a', tool: 'echo', args: {} });
    expect(link('b', { text: 'x', previous: { success: true, answer: 'a worked' } }, 2)).toEqual({ text: 'x' });
    expect(recorder.steps()[0]?.outcome).toEqual({ success: true, answer: 'a worked', source: 'previous' });
    expect(events).toEqual([]);
  });

  it('does not warn on the first tool turn, or when a directive already covered the step', () => {
    const { recorder, events, link } = setup();
    expect(link('a', { text: 'x', previous: null }, 1)).toEqual({ text: 'x' });
    recorder.begin({ turn: 1, callId: 'a', tool: 'echo', args: {} });
    expect(link('b', { text: 'y' }, 1)).toEqual({ text: 'y' });
    recorder.attachOutcome({ outcome: { success: true, answer: 'ok' }, source: 'directive' });
    link('c', { text: 'z' }, 2);
    expect(events).toEqual([]);
  });

  it('warns once per run about a missing previous after the first tool turn', () => {
    const { recorder, events, feedback, link } = setup();
    recorder.begin({ turn: 1, callId: 'a', tool: 'echo', args: {} });
    link('b', { text: 'y' }, 2);
    recorder.begin({ turn: 2, callId: 'b', tool: 'echo', args: {} });
    link('c', { text: 'z', previous: null }, 3);
    expect(events).toEqual([{ type: 'warning', message: expect.stringContaining("tool call 'b' to 'echo'") }]);
    expect(feedback.hasWarnedMissing).toBe(true);
  });

  it('warns about an invalid previous each time, and does not record it', () => {
    const { recorder, events, link } = setup();
    recorder.begin({ turn: 1, callId: 'a', tool: 'echo', args: {} });
    link('b', { previous: { success: 1, answer: 'x' } }, 2);
    link('c', { previous: { success: true } }, 2);
    expect(events.map(event => event.type === 'warning' && event.message)).toEqual([
      expect.stringMatching(/^Ignored invalid previous on call 'b' to 'echo': success/),
      expect.stringMatching(/^Ignored invalid previous on call 'c' to 'echo': answer/),
    ]);
    expect(recorder.steps()[0]?.outcome).toBeUndefined();
  });
});
