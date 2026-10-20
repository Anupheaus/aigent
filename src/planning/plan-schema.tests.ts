import { describe, expect, it } from 'vitest';
import { parseTaskInput } from '../core/task-input.js';
import { planSchema } from './plan-schema.js';

const ITEM = { id: 'p1', label: 'Find the file', description: 'Locate the theme provider', acceptanceCriteria: ['Path reported'] };

describe('planSchema', () => {
  it('accepts a valid plan', () => {
    expect(planSchema.parse([ITEM, { ...ITEM, id: 'p2' }])).toHaveLength(2);
  });

  it('rejects duplicate ids, naming them', () => {
    const result = planSchema.safeParse([ITEM, { ...ITEM }, { ...ITEM, id: 'p2' }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toContain("duplicate plan item id 'p1'");
  });

  it('rejects empty and oversize fields with precise paths', () => {
    const result = planSchema.safeParse([{ ...ITEM, acceptanceCriteria: [] }, { ...ITEM, id: 'x'.repeat(41), label: '' }]);
    expect(result.error?.issues.map(({ path }) => path.join('.')).sort()).toEqual(['0.acceptanceCriteria', '1.id', '1.label']);
    expect(planSchema.safeParse(Array.from({ length: 51 }, (_unused, index) => ({ ...ITEM, id: `p${index}` }))).success).toBe(false);
  });

  it('makes a task with an invalid plan fail with invalid_input naming the problem', () => {
    expect(() => parseTaskInput({ task: 'x', plan: [ITEM, ITEM] })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining("duplicate plan item id 'p1'") }));
    expect(() => parseTaskInput({ task: 'x', plan: [{ ...ITEM, acceptanceCriteria: [] }] })).toThrow(/plan\.0\.acceptanceCriteria/);
  });
});
