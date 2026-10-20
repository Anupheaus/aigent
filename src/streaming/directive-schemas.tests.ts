import { describe, expect, it } from 'vitest';
import { DIRECTIVE_SCHEMAS, MAX_PLANNING_CHANGES } from './directive-schemas.js';

describe('DIRECTIVE_SCHEMAS', () => {
  it('caps plan updates and todo ops per directive like the tools do (review M10)', () => {
    const updates = Array.from({ length: MAX_PLANNING_CHANGES + 1 }, () => ({ id: 'p1', status: 'in_progress' }));
    const ops = Array.from({ length: MAX_PLANNING_CHANGES + 1 }, () => ({ op: 'add', label: 'x' }));
    expect(DIRECTIVE_SCHEMAS.plan.safeParse({ updates }).success).toBe(false);
    expect(DIRECTIVE_SCHEMAS.todo.safeParse({ ops }).success).toBe(false);
    expect(DIRECTIVE_SCHEMAS.todo.safeParse({ ops: ops.slice(1) }).success).toBe(true);
  });

  it('limits ids to 40 characters, as consumer plan ids are', () => {
    expect(DIRECTIVE_SCHEMAS.todo.safeParse({ ops: [{ op: 'add', id: 'x'.repeat(41), label: 'x' }] }).success).toBe(false);
    expect(DIRECTIVE_SCHEMAS.plan.safeParse({ updates: [{ id: 'x'.repeat(41), status: 'done', evidence: 'e' }] }).success).toBe(false);
  });

  it('accepts a reason on todo ops, for going back from done or blocked', () => {
    expect(DIRECTIVE_SCHEMAS.todo.safeParse({ ops: [{ op: 'set_status', id: 't1', status: 'pending', reason: 'reverted' }] }).success).toBe(true);
  });
});
