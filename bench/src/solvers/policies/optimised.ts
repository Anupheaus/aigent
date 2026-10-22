import { solveOptimised } from '../strategies/optimised.js';
import type { OptimisedRound } from '../strategies/optimised.js';
import { createPolicy } from './dispatch.js';
import type { Policy } from '../policy-types.js';

/**
 * The optimised policy as of a round: it uses the new tools exactly as their descriptions say (layers, tags, index
 * lookups), and falls back to the reference strategy where a round brought nothing better.
 */
export function optimisedPolicy(round: OptimisedRound): Policy {
  return createPolicy({ style: 'good', override: ({ ctx, intent }) => solveOptimised({ ctx, intent, round }) });
}
