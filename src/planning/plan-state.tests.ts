import { describe, expect, it } from 'vitest';
import type { PlanItem } from './plan-schema.js';
import { applyPlanUpdates, createPlanningState } from './plan-state.js';

const PLAN: PlanItem[] = [
  { id: 'p1', label: 'Find', description: 'Find it', acceptanceCriteria: ['found'] },
  { id: 'p2', label: 'Fix', description: 'Fix it', acceptanceCriteria: ['fixed'] },
];

function state() {
  return createPlanningState({ plan: PLAN });
}

describe('applyPlanUpdates', () => {
  it('starts every item pending and applies valid updates in order', () => {
    const planning = state();
    expect(planning.plan.map(({ status }) => status)).toEqual(['pending', 'pending']);
    const results = applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'in_progress' }, { id: 'p1', status: 'done', evidence: 'src/a.ts:12' }] });
    expect(results).toEqual([{ ok: true, id: 'p1', changed: true }, { ok: true, id: 'p1', changed: true }]);
    expect(planning.plan[0]).toMatchObject({ status: 'done', evidence: 'src/a.ts:12' });
  });

  it('rejects an unknown id per item, listing the valid ids, and still applies the others', () => {
    const planning = state();
    const results = applyPlanUpdates({ state: planning, updates: [{ id: 'p9', status: 'done', evidence: 'x' }, { id: 'p2', status: 'in_progress' }] });
    expect(results[0]).toEqual({ ok: false, error: expect.objectContaining({ code: 'unknown_plan_item', category: 'validation', message: expect.stringContaining("'p9'"), suggestion: 'Valid plan item ids: p1, p2' }) });
    expect(results[1]).toMatchObject({ ok: true, id: 'p2' });
    expect(planning.plan[1]?.status).toBe('in_progress');
  });

  it('requires evidence to mark an item done', () => {
    const planning = state();
    expect(applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'done' }] })[0]).toEqual({ ok: false, error: expect.objectContaining({ code: 'evidence_required', message: expect.stringContaining("'p1'") }) });
    expect(planning.plan[0]?.status).toBe('pending');
  });

  it('rejects a silent regression from done or blocked, and records one that gives evidence', () => {
    const planning = state();
    applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'done', evidence: 'ok' }, { id: 'p2', status: 'blocked' }] });
    const silent = applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'pending' }, { id: 'p2', status: 'in_progress' }] });
    expect(silent.map(result => (result.ok ? 'ok' : result.error.code))).toEqual(['status_regression', 'status_regression']);
    expect(planning.plan.map(({ status }) => status)).toEqual(['done', 'blocked']);
    const explained = applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'in_progress', evidence: 'test failed again' }] });
    expect(explained[0]).toMatchObject({ ok: true });
    expect(planning.plan[0]).toMatchObject({ status: 'in_progress', evidence: 'test failed again' });
  });

  it('treats repeating the same status as an idempotent success, even done without new evidence', () => {
    const planning = state();
    applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'done', evidence: 'ok' }] });
    expect(applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'done' }] })).toEqual([{ ok: true, id: 'p1', changed: false }]);
    expect(planning.plan[0]?.evidence).toBe('ok');
  });

  it('copies the consumer plan so the input is never mutated', () => {
    const input = structuredClone(PLAN);
    const planning = createPlanningState({ plan: input });
    applyPlanUpdates({ state: planning, updates: [{ id: 'p1', status: 'in_progress' }] });
    expect(input).toEqual(PLAN);
  });
});
