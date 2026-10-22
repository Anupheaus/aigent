import type { Budget, TaskSpec } from '../task-spec.js';
import type { CheckResult } from './check-result.js';

/** What a run achieved: wrong answers fail outright; correct ones are placed by the tightest budget they meet. */
export type Tier = 'stretch' | 'target' | 'pass' | 'over-budget' | 'fail';

/** What a run used. */
export interface RunUsage {
  tokens: number;
  turns: number;
  toolCalls: number;
  ms: number;
}

export const TIER_FACTORS = { stretch: 0.8, target: 1.5, pass: 4 } as const;

export const within = (usage: RunUsage, budget: Budget): boolean =>
  usage.tokens <= budget.maxTokens && usage.turns <= budget.maxTurns && usage.toolCalls <= budget.maxToolCalls && usage.ms <= budget.maxMs;

/** The tier of a run: budgets count only for a correct answer (a fast wrong answer is a failure). */
export function tierOf(params: { spec: TaskSpec; check: CheckResult; usage: RunUsage }): Tier {
  const { spec: { budgets }, check, usage } = params;
  if (!check.correct) return 'fail';
  if (within(usage, budgets.stretch)) return 'stretch';
  if (within(usage, budgets.target)) return 'target';
  if (within(usage, budgets.pass)) return 'pass';
  return 'over-budget';
}

/** Budgets from the reference's measured cost: pass 4x and target 1.5x (rounded up), stretch 0.8x (rounded down). */
export function budgetsFrom(measured: RunUsage): TaskSpec['budgets'] {
  const scaled = (factor: number, round: (value: number) => number): Budget => ({
    maxTokens: round(measured.tokens * factor), maxTurns: round(measured.turns * factor), maxToolCalls: round(measured.toolCalls * factor), maxMs: round(measured.ms * factor),
  });
  return { pass: scaled(TIER_FACTORS.pass, Math.ceil), target: scaled(TIER_FACTORS.target, Math.ceil), stretch: scaled(TIER_FACTORS.stretch, Math.floor) };
}
