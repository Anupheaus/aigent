import type { Acceptance, Budget, DecoyRef, GroundTruth, TaskSpec } from '../task-spec.js';

const BUDGET: Budget = { maxTokens: 1_000, maxTurns: 4, maxToolCalls: 4, maxMs: 1_000 };

/** A minimal spec for checker tests: only the parts the checker reads are meaningful. */
export function specWith(params: { groundTruth: GroundTruth; accept?: Partial<Acceptance>; decoys?: DecoyRef[]; budgets?: TaskSpec['budgets'] }): TaskSpec {
  const { groundTruth, accept = {}, decoys = [], budgets = { pass: { ...BUDGET, maxTokens: 4_000 }, target: { ...BUDGET, maxTokens: 1_500 }, stretch: { ...BUDGET, maxTokens: 800 } } } = params;
  return {
    id: 'test/precise/small/s1', family: 'test', variant: 'precise', prompt: 'p', scope: ['.'], query: 'string-usage', repo: { seed: 1, size: 'small' }, heldOut: false, givenTerms: [],
    groundTruth, decoys, accept: { kind: 'set', minRecall: 1, minPrecision: 1, ...accept }, budgets,
    reference: { description: 'r', steps: [], measured: { tokens: 1_000, turns: 2, toolCalls: 1, ms: 100 } },
  };
}
