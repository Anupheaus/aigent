import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resultsDir } from './bench-paths.js';
import { BUDGET_HEADROOM, budgetsFrom, checkGate, readBudgets } from './gate.js';
import type { SuiteReport } from './harness/report.js';

const round3 = JSON.parse(await readFile(join(resultsDir(), 'round-3.json'), 'utf8')) as SuiteReport;
const budgets = await readBudgets();

describe('CI budget gate', () => {
  it('passes the proven round against the committed budgets', () => {
    expect(budgets).toMatchObject({ round: 'round-3', policy: 'optimised', tools: 'optimised', minPassRate: 1 });
    expect(checkGate({ report: round3, budgets })).toEqual({ ok: true, failures: [] });
  });

  it('fails a regressed run: dearer specs, a wrong answer, more turns', () => {
    const regressed = round3.rows.map((row, index) => (index === 0 ? { ...row, correct: false, tier: 'fail' as const } : { ...row, tokens: Math.ceil(row.tokens * 1.3), turns: row.turns + 2 }));
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

  it(`derives budgets from the best run of each spec with ${Math.round((BUDGET_HEADROOM - 1) * 100)}% headroom`, () => {
    const rows = round3.rows.filter(({ taskId }) => taskId === 'find-named-file/precise/small/s1');
    const derived = budgetsFrom({ rows, round: 'r', policy: 'optimised', tools: 'optimised' });
    const best = Math.min(...rows.map(({ tokens }) => tokens));
    expect(derived.specs['find-named-file/precise/small/s1']?.maxTokens).toBe(Math.ceil(best * BUDGET_HEADROOM));
    expect(() => budgetsFrom({ rows: [], round: 'r', policy: 'optimised', tools: 'optimised' })).toThrow(/no rows/);
  });
});
