import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchRoot } from './bench-paths.js';
import { benchError } from './bench-error.js';
import { aggregate, quantile } from './harness/report.js';
import type { RunRow } from './harness/run-task.js';
import type { SuiteReport } from './harness/report.js';

/** Headroom over the best proven round when budgets are tightened. */
export const BUDGET_HEADROOM = 1.15;
/** Missing spec ids named in a gate failure. */
const MISSING_SHOWN = 5;

/** One spec's committed limits for the gated policy. */
export interface SpecBudget {
  maxTokens: number;
  maxTurns: number;
  maxToolCalls: number;
}

/** `bench/budgets.json`: what CI enforces on the scripted tier. */
export interface BenchBudgets {
  /** The round the budgets come from (they only tighten after a round proves an improvement). */
  round: string;
  policy: string;
  tools: string;
  minPassRate: number;
  maxMedianTokens: number;
  maxP90Turns: number;
  specs: Record<string, SpecBudget>;
}

export const budgetsPath = (): string => join(benchRoot(), 'budgets.json');

const up = (value: number): number => Math.ceil(value * BUDGET_HEADROOM);
/** Integer counts (turns, tool calls) get the headroom only when it is at least one whole step (2 turns stay 2). */
const upCount = (value: number): number => Math.max(value, Math.floor(value * BUDGET_HEADROOM));

/** Budgets from a proven round's rows for one policy: each spec's best run plus 15% headroom; headline metrics likewise. */
export function budgetsFrom(params: { rows: RunRow[]; round: string; policy: string; tools: string }): BenchBudgets {
  const { rows, round, policy, tools } = params;
  const mine = rows.filter(({ solver, heldOut }) => solver === policy && !heldOut);
  if (mine.length === 0) throw benchError(`budgetsFrom: no rows of policy '${policy}' in ${round}`, { policy, round });
  const [headline] = aggregate(mine);
  const specs: Record<string, SpecBudget> = {};
  for (const row of [...mine].sort((first, second) => first.taskId.localeCompare(second.taskId))) {
    const best = specs[row.taskId];
    const next = { maxTokens: up(row.tokens), maxTurns: upCount(row.turns), maxToolCalls: upCount(row.toolCalls) };
    specs[row.taskId] = best == null ? next : { maxTokens: Math.min(best.maxTokens, next.maxTokens), maxTurns: Math.min(best.maxTurns, next.maxTurns), maxToolCalls: Math.min(best.maxToolCalls, next.maxToolCalls) };
  }
  return { round, policy, tools, minPassRate: headline?.passRate ?? 1, maxMedianTokens: up(headline?.medianTokens ?? 0), maxP90Turns: upCount(headline?.p90Turns ?? 0), specs };
}

/**
 * What a run must not do against the budgets: lose pass rate, raise median tokens or p90 turns, exceed a spec's limits,
 * leave a budgeted spec out (a subset could hide a regression) or run a spec that has no budget (a renamed spec would
 * otherwise escape its limits).
 */
export function checkGate(params: { report: Pick<SuiteReport, 'rows'>; budgets: BenchBudgets }): { ok: boolean; failures: string[] } {
  const { report, budgets } = params;
  const rows = report.rows.filter(({ solver, heldOut }) => solver === budgets.policy && !heldOut);
  if (rows.length === 0) return { ok: false, failures: [`no rows of policy '${budgets.policy}' to gate`] };
  const passRate = rows.filter(({ tier }) => tier === 'pass' || tier === 'target' || tier === 'stretch').length / rows.length;
  const correct = rows.filter(({ correct }) => correct);
  const medianTokens = quantile(correct.map(({ tokens }) => tokens), 0.5);
  const p90Turns = quantile(correct.map(({ turns }) => turns), 0.9);
  const ran = new Set(rows.map(({ taskId }) => taskId));
  const missing = Object.keys(budgets.specs).filter(taskId => !ran.has(taskId));
  const failures = [
    ...(missing.length === 0 ? [] : [`not run: ${missing.length} budgeted spec(s), e.g. ${missing.slice(0, MISSING_SHOWN).join(', ')}`]),
    ...(passRate < budgets.minPassRate ? [`pass rate ${passRate.toFixed(3)} < ${budgets.minPassRate}`] : []),
    ...(medianTokens > budgets.maxMedianTokens ? [`median tokens ${medianTokens} > ${budgets.maxMedianTokens}`] : []),
    ...(p90Turns > budgets.maxP90Turns ? [`p90 turns ${p90Turns} > ${budgets.maxP90Turns}`] : []),
    ...rows.flatMap(row => {
      const limit = budgets.specs[row.taskId];
      if (limit == null) return [`${row.taskId}: no budget`];
      return [
        ...(!row.correct ? [`${row.taskId}: wrong answer`] : []),
        ...(row.tokens > limit.maxTokens ? [`${row.taskId}: tokens ${row.tokens} > ${limit.maxTokens}`] : []),
        ...(row.turns > limit.maxTurns ? [`${row.taskId}: turns ${row.turns} > ${limit.maxTurns}`] : []),
        ...(row.toolCalls > limit.maxToolCalls ? [`${row.taskId}: tool calls ${row.toolCalls} > ${limit.maxToolCalls}`] : []),
      ];
    }),
  ];
  return { ok: failures.length === 0, failures };
}

export async function readBudgets(path: string = budgetsPath()): Promise<BenchBudgets> {
  return JSON.parse(await readFile(path, 'utf8')) as BenchBudgets;
}

export async function writeBudgets(params: { budgets: BenchBudgets; path?: string }): Promise<void> {
  await writeFile(params.path ?? budgetsPath(), `${JSON.stringify(params.budgets, null, 2)}\n`, 'utf8');
}
