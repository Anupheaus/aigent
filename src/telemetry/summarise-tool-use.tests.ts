import { describe, expect, it } from 'vitest';
import type { TraceStep } from './run-record.js';
import { summariseToolUse } from './summarise-tool-use.js';

function step(overrides: Partial<TraceStep> & Pick<TraceStep, 'index' | 'tool'>): TraceStep {
  return { turn: 1, callId: `c${overrides.index}`, argsSummary: '{}', ok: true, resultBytes: 1, resultTokens: 1, truncated: false, durationMs: 1, startedAtMs: 0, ...overrides };
}

describe('summariseToolUse', () => {
  it('counts work calls, batch items and repeated calls, skipping wrappers and commentary', () => {
    const steps = [
      step({ index: 0, tool: 'aigent_multi' }),
      step({ index: 1, tool: 'read', parentCallId: 'c0', argsSummary: '{"path":"a"}' }),
      step({ index: 2, tool: 'read', parentCallId: 'c0', argsSummary: '{"path":"a"}' }),
      step({ index: 3, tool: 'read_all', itemTotal: 4, itemFailures: 1, argsSummary: '{"items":[]}' }),
      step({ index: 4, tool: 'aigent_feedback' }),
      step({ index: 5, tool: 'read', argsSummary: '{"path":"a"}' }),
    ];
    expect(summariseToolUse({ steps, nonWorkTools: ['aigent_multi', 'aigent_feedback'] })).toEqual({ calls: 4, items: 7, repeats: 2 });
  });

  it('is all zeros without steps', () => {
    expect(summariseToolUse({ steps: [], nonWorkTools: [] })).toEqual({ calls: 0, items: 0, repeats: 0 });
  });
});
