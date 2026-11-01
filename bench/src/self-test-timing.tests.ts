import { describe, expect, it } from 'vitest';
import { naivePassedPoorly, SELF_TEST_TIMEOUT_MS, selfTest, selfTestFindings, selfTestSpecs } from './self-test.test-support.js';
import type { SelfTestRows } from './self-test.test-support.js';
import { scriptedSolver } from './solvers/registry.js';
import type { Solver } from './solvers/solver-types.js';
import type { TaskSpec } from './task-spec.js';
import { MAX_SLOWDOWN } from './wall-time.test-support.js';

/** How long a busy solver blocks the event loop (as a CPU-heavy policy does). */
const BUSY_MS = 500;
/** The tightest declared target the slow-reference test sets: even at the largest slowdown, far below the delay. */
const TINY_TARGET_MS = 20;
/** The slow reference's added wait: past `TINY_TARGET_MS` at any accepted slowdown. */
const SLOW_DELAY_MS = TINY_TARGET_MS * MAX_SLOWDOWN * 4;

const [spec] = (await selfTestSpecs(0)).filter(({ repo: { size } }) => size === 'small');

/** When a solver's run started and ended. */
interface RunWindow {
  start: number;
  end: number;
}

/** A solver that records when it ran and, when `isBusy`, blocks the event loop first (as a CPU-heavy policy does). */
const watched = (params: { base: Solver; windows: RunWindow[]; isBusy?: boolean }): Solver => {
  const { base, windows, isBusy = false } = params;
  return {
    id: base.id,
    solve: async task => {
      const start = performance.now();
      const until = start + BUSY_MS;
      while (isBusy && performance.now() < until) { /* blocks the event loop on purpose */ }
      const outcome = await base.solve(task);
      windows.push({ start, end: performance.now() });
      return outcome;
    },
  };
};

/** A solver that plays `base` and then waits: a genuinely slow policy with the same counts. */
const slow = (base: Solver): Solver => ({
  id: `${base.id}-slow`,
  solve: async task => {
    const outcome = await base.solve(task);
    await new Promise(resolve => setTimeout(resolve, SLOW_DELAY_MS));
    return { ...outcome, usage: { ...outcome.usage, ms: outcome.usage.ms + SLOW_DELAY_MS } };
  },
});

const withTarget = (base: TaskSpec, maxMs: number): TaskSpec => ({ ...base, budgets: { ...base.budgets, target: { ...base.budgets.target, maxMs }, stretch: { ...base.budgets.stretch, maxMs: Math.min(base.budgets.stretch.maxMs, maxMs) } } });

describe('self-test wall time', () => {
  it('times the reference on its own: other solvers\' work is not counted against it', async () => {
    if (spec == null) throw new Error('no small self-test spec');
    const reference: RunWindow[] = [];
    const others: RunWindow[] = [];
    const rows = await selfTest(spec, {
      reference: watched({ base: scriptedSolver('reference'), windows: reference }),
      naive: watched({ base: scriptedSolver('naive'), windows: others, isBusy: true }),
      decoy: watched({ base: scriptedSolver('decoy'), windows: others, isBusy: true }),
    });
    // Run together, the busy solvers' blocking would fall inside the reference's measured time; one after another, no
    // other solver runs while the reference is timed (whatever the machine's load).
    const [own] = reference;
    expect(own).toBeDefined();
    for (const other of others) expect(other.end <= (own?.start ?? 0) || other.start >= (own?.end ?? 0), JSON.stringify({ own, other })).toBe(true);
    expect(others).toHaveLength(2);
    expect(selfTestFindings({ spec, rows })).toEqual([]);
  }, SELF_TEST_TIMEOUT_MS);

  it('a genuinely slow reference still fails the time check (the slowdown is bounded)', async () => {
    if (spec == null) throw new Error('no small self-test spec');
    const tight = withTarget(spec, TINY_TARGET_MS);
    const rows = await selfTest(tight, { reference: slow(scriptedSolver('reference')) });
    const findings = selfTestFindings({ spec: tight, rows });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^reference took \d+ ms, over the declared 20 ms x machine slowdown/);
  }, SELF_TEST_TIMEOUT_MS);

  it('judges counts exactly and wall time against the declared time scaled by the machine\'s slowdown', async () => {
    if (spec == null) throw new Error('no small self-test spec');
    const rows = await selfTest(spec);
    const { target, pass } = spec.budgets;
    const over: SelfTestRows = { ...rows, reference: { ...rows.reference, ms: target.maxMs + 1 }, slowdowns: { ...rows.slowdowns, reference: 1 } };
    expect(selfTestFindings({ spec, rows: over })).toEqual([`reference took ${target.maxMs + 1} ms, over the declared ${target.maxMs} ms x machine slowdown 1.00 = ${target.maxMs} ms`]);
    const scaled: SelfTestRows = { ...over, slowdowns: { ...rows.slowdowns, reference: 2 } };
    expect(selfTestFindings({ spec, rows: scaled })).toEqual([]);
    const extraTurn: SelfTestRows = { ...rows, reference: { ...rows.reference, turns: rows.reference.turns + 1 } };
    expect(selfTestFindings({ spec, rows: extraTurn }).join('\n')).toContain('reference measured');
    expect(naivePassedPoorly({ ...rows, naive: { ...rows.naive, ms: pass.maxMs + 1 }, slowdowns: { ...rows.slowdowns, naive: 1 } })).toBe(false);
    expect(naivePassedPoorly({ ...rows, naive: { ...rows.naive, ms: pass.maxMs + 1 }, slowdowns: { ...rows.slowdowns, naive: 2 } })).toBe(naivePassedPoorly(rows));
  }, SELF_TEST_TIMEOUT_MS);
});
