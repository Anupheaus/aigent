import { describe, expect, it } from 'vitest';
import { parseTaskInput } from './task-input.js';

describe('parseTaskInput', () => {
  it('accepts a minimal and a full input', () => {
    expect(parseTaskInput({ task: 'Find X' })).toEqual({ task: 'Find X' });
    const full = { task: 'Find X', context: 'c', inScope: ['a'], outOfScope: ['b'], constraints: ['k'], acceptanceCriteria: ['z'], onAmbiguity: 'assume' as const, unattended: true, label: 'l', scope: { userId: '1' }, inputs: { id: 3 }, references: [{ label: 'r', content: 'text' }], disableTelemetry: true, limits: { maxTurns: 3 } };
    expect(parseTaskInput(full)).toEqual(full);
  });

  it('rejects an empty task and unknown fields with a precise error', () => {
    expect(() => parseTaskInput({ task: '' })).toThrow(/task/);
    expect(() => parseTaskInput({})).toThrow(/task/);
    expect(() => parseTaskInput({ task: 'x', bogus: 1 })).toThrow(/bogus/);
  });
});
