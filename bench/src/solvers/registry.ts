import { benchError } from '../bench-error.js';
import type { Policy } from './policy-types.js';
import { decoyFallingPolicy } from './policies/decoy-falling.js';
import { goodPolicy } from './policies/good.js';
import { lazyPolicy } from './policies/lazy.js';
import { naivePolicy } from './policies/naive.js';
import { optimisedPolicy } from './policies/optimised.js';
import { createScriptedSolver } from './scripted-solver.js';
import type { Solver } from './solver-types.js';

/** The scripted policies by CLI name. */
export const SCRIPTED_POLICIES: Record<string, Policy> = {
  reference: goodPolicy, naive: naivePolicy, decoy: decoyFallingPolicy, lazy: lazyPolicy,
  'optimised-r1': optimisedPolicy(1), 'optimised-r2': optimisedPolicy(2), optimised: optimisedPolicy(3),
};

export function scriptedSolver(name: string): Solver {
  const policy = SCRIPTED_POLICIES[name];
  if (policy == null) throw benchError(`unknown policy '${name}'; expected one of ${Object.keys(SCRIPTED_POLICIES).join(', ')}`, { name });
  return createScriptedSolver({ id: name, policy });
}
