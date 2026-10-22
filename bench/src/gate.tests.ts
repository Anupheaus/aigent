import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resultsDir } from './bench-paths.js';
import { BUDGET_HEADROOM, budgetsFrom, checkGate, readBudgets } from './gate.js';
import type { SuiteReport } from './harness/report.js';

const round3 = JSON.parse(await readFile(join(resultsDir(), 'round-3.json'), 'utf8')) as SuiteReport;
const budgets = await readBudgets();
/** The rows CI produces: the committed specs only (the round's fresh-seed rows have no budgets by design). */
const committedRows = round3.rows.filter(({ taskId }) => budgets.specs[taskId] != null);

describe('CI budget gate', () => {
  it('passes the proven round against the committed budgets', () => {
    expect(budgets).toMatchObject({ round: 'round-3', policy: 'optimised', tools: 'optimised', minPassRate: 1 });
    expect(checkGate({ report: { rows: committedRows }, budgets })).toEqual({ ok: true, failures: [] });
    expect(checkGate({ report: round3, budgets }).ok).toBe(false);
  });

  it('fails a regressed run: dearer specs, a wrong answer, more turns', () => {
    const regressed = committedRows.map((row, index) => (index === 0 ? { ...row, correct: false, tier: 'fail' as const } : { ...row, tokens: Math.ceil(row.tokens * 1.3), turns: row.turns + 2 }));
    const gate = checkGate({ report: { rows: regressed }, budgets });
    expect(gate.ok).toBe(false);
    expect(gate.failures.join('\n')).toMatch(/pass rate/);
    expect(gate.failures.join('\n')).toMatch(/median tokens/);
    expect(gate.failures.join('\n')).toMatch(/p90 turns/);
    expect(gate.failures.join('\n')).toMatch(/wrong answer/);
  });

  it('fails when the gated policy did not run', () => {
    expect(checkGate({ report: { rows: [] }, budgets }).ok).toBe(false);
  });

  it('fails a run that left budgeted specs out (a --tasks or --seed subset cannot pass the gate)', () => {
    const subset = round3.rows.filter(({ taskId }) => taskId.startsWith('none-exist/'));
    const gate = checkGate({ report: { rows: subset }, budgets });
    expect(gate.ok).toBe(false);
    expect(gate.failures.join('\n')).toMatch(/not run: \d+ budgeted spec/);
  });

  it('fails rows of specs that have no budget (renamed or new specs are not waved through)', () => {
    const renamed = committedRows.map(row => ({ ...row, taskId: `x/${row.taskId}` }));
    const gate = checkGate({ report: { rows: renamed }, budgets });
    expect(gate.ok).toBe(false);
    expect(gate.failures.join('\n')).toMatch(/x\/find-named-file\/precise\/small\/s1: no budget/);
  });

  it('keeps integer limits (turns, tool calls) at the proven value when 15% headroom is less than one', () => {
    const rows = round3.rows.filter(({ taskId }) => taskId === 'find-named-file/precise/small/s1').map(row => ({ ...row, turns: 2, toolCalls: 1 }));
    const derived = budgetsFrom({ rows, round: 'r', policy: 'optimised', tools: 'optimised' });
    expect(derived.specs['find-named-file/precise/small/s1']).toMatchObject({ maxTurns: 2, maxToolCalls: 1 });
    expect(derived.maxP90Turns).toBe(2);
    expect(budgetsFrom({ rows: rows.map(row => ({ ...row, turns: 10 })), round: 'r', policy: 'optimised', tools: 'optimised' }).maxP90Turns).toBe(11);
  });

  it(`derives budgets from the best run of each spec with ${Math.round((BUDGET_HEADROOM - 1) * 100)}% headroom`, () => {
    const rows = round3.rows.filter(({ taskId }) => taskId === 'find-named-file/precise/small/s1');
    const derived = budgetsFrom({ rows, round: 'r', policy: 'optimised', tools: 'optimised' });
    const best = Math.min(...rows.map(({ tokens }) => tokens));
    expect(derived.specs['find-named-file/precise/small/s1']?.maxTokens).toBe(Math.ceil(best * BUDGET_HEADROOM));
    expect(() => budgetsFrom({ rows: [], round: 'r', policy: 'optimised', tools: 'optimised' })).toThrow(/no rows/);
  });
});
