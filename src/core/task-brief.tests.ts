import { describe, expect, it } from 'vitest';
import { buildTaskBrief } from './task-brief.js';

describe('buildTaskBrief', () => {
  it('renders only the provided sections, goal first', () => {
    expect(buildTaskBrief({ task: 'Find X' })).toBe('# Task\nFind X');
  });

  it('renders every optional field in a fixed order', () => {
    const brief = buildTaskBrief({
      task: 'Find X', context: 'bg', inputs: { id: 1 }, references: [{ label: 'Doc', content: 'text' }, { label: 'File', path: 'a.ts' }],
      inScope: ['src'], outOfScope: ['dist'], constraints: ['be brief'], acceptanceCriteria: ['has path'], onAmbiguity: 'assume', unattended: true,
    });
    const order = ['# Task', '## Context', '## Inputs', '## References', '## In scope', '## Out of scope', '## Constraints', '## Acceptance criteria', '## Ambiguity'];
    const positions = order.map(heading => brief.indexOf(heading));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(brief).toContain('"id": 1');
    expect(brief).toContain('- has path');
    expect(brief).toMatch(/no user is available/i);
  });
});
