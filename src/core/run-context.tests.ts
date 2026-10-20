import { describe, expect, it } from 'vitest';
import { appendContextMessages, createRunContext, issueContextMessage, renumber } from './run-context.js';
import { recordPromptSize } from './run-request.js';

function context() {
  return createRunContext({ runId: 'run', createdAt: 1, initial: [{ kind: 'system', message: { role: 'system', text: 's' } }, { kind: 'brief', message: { role: 'user', text: 'b' } }] });
}

describe('run context', () => {
  it('stores the initial messages with ids and seqs in order and default flags', () => {
    const { state, ratio, peakTokens } = context();
    expect(state.map(({ id, seq, kind, compactable }) => ({ id, seq, kind, compactable }))).toEqual([
      { id: 'run:m0', seq: 0, kind: 'system', compactable: false },
      { id: 'run:m1', seq: 1, kind: 'brief', compactable: false },
    ]);
    expect({ ratio, peakTokens }).toEqual({ ratio: 1, peakTokens: 0 });
  });

  it('appends at the end, never reusing an id after messages were removed and renumbered', () => {
    const run = context();
    appendContextMessages({ context: run, createdAt: 2, messages: [{ kind: 'assistant', pairId: 'c1', message: { role: 'assistant', toolCalls: [{ id: 'c1', name: 't', args: {} }] } }, { kind: 'tool', pairId: 'c1', flags: { compactable: false }, message: { role: 'tool', toolCallId: 'c1', text: 'r' } }] });
    run.state.splice(1, 1);
    renumber(run.state);
    const issued = issueContextMessage({ context: run, entry: { kind: 'user', message: { role: 'user', text: 'u' } }, createdAt: 3 });
    expect(run.state.map(({ id, seq }) => `${id}@${seq}`)).toEqual(['run:m0@0', 'run:m2@1', 'run:m3@2']);
    expect(issued.id).toBe('run:m4');
    expect(run.state[2]).toMatchObject({ kind: 'tool', compactable: false, pairId: 'c1', createdAt: 2 });
  });

  it('calibrates from reported input tokens and keeps the peak prompt size', () => {
    const run = context();
    recordPromptSize({ context: run, estimatedTokens: 100 });
    expect({ ratio: run.ratio, peak: run.peakTokens }).toEqual({ ratio: 1, peak: 100 });
    recordPromptSize({ context: run, estimatedTokens: 100, reportedTokens: 150 });
    expect({ ratio: run.ratio, peak: run.peakTokens }).toEqual({ ratio: 1.5, peak: 150 });
    recordPromptSize({ context: run, estimatedTokens: 40, reportedTokens: 0 });
    expect({ ratio: run.ratio, peak: run.peakTokens }).toEqual({ ratio: 1.5, peak: 150 });
  });
});
