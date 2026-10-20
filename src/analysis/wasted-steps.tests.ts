import { describe, expect, it } from 'vitest';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import { wastedStepsOf } from './wasted-steps.js';

describe('wastedStepsOf', () => {
  it('names one reason per step, the first that applies', () => {
    const trace = fixtureTrace({ run: { startedAt: 1 }, steps: [
      { tool: 'search', turn: 1, argsSummary: '{"query":"a"}', ok: false },
      { tool: 'search', turn: 2, argsSummary: '{"query":"b"}' },
      { tool: 'search', turn: 3, argsSummary: '{"query":"b"}' },
      { tool: 'search', turn: 4, argsSummary: '{"query":"c"}' },
    ] });
    expect(wastedStepsOf(trace)).toEqual([
      { runId: 'run_0001', stepIndex: 0, reason: 'failed-before-success' },
      { runId: 'run_0001', stepIndex: 1, reason: 'superseded-search' },
      { runId: 'run_0001', stepIndex: 2, reason: 'repeat-call' },
    ]);
  });

  it('ignores wrappers and commentary, and does not call a dependent follow-up unbatched', () => {
    const trace = fixtureTrace({ run: { startedAt: 1 }, steps: [
      { tool: 'read', turn: 1, argsSummary: '{"path":"a"}' },
      { tool: 'aigent_feedback', turn: 2 },
      { tool: 'edit', turn: 2, argsSummary: '{"path":"a"}' },
      { tool: 'read', turn: 3, argsSummary: '{"path":"b"}' },
    ] });
    expect(wastedStepsOf(trace)).toEqual([]);
  });
});

describe('wastedStepsOf with argument digests', () => {
  it('uses digests over shape-only summaries, so different values are not repeats and a refined search is superseded', () => {
    const shape = '{"query":"<string>"}';
    const trace = fixtureTrace({ run: { startedAt: 1 }, steps: [
      { tool: 'search', turn: 1, argsSummary: shape, argsHash: 'h-a' },
      { tool: 'search', turn: 2, argsSummary: shape, argsHash: 'h-b' },
      { tool: 'search', turn: 3, argsSummary: shape, argsHash: 'h-b' },
    ] });
    expect(wastedStepsOf(trace)).toEqual([
      { runId: 'run_0001', stepIndex: 0, reason: 'superseded-search' },
      { runId: 'run_0001', stepIndex: 2, reason: 'repeat-call' },
    ]);
  });
});
