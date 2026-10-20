import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';

/** When and how far a run compacts its history; fractions are of the usable prompt budget. */
export interface CompactionPolicy {
  /** Compaction starts once the estimated prompt reaches this fraction of the usable budget. */
  compactAt: number;
  /** ...and stops once it is at or below this fraction (hysteresis: well below `compactAt`, so it fires rarely). */
  compactTo: number;
  /** The most recent tool rounds (turns) that are always kept verbatim. At least 1. */
  keepRecent: number;
  /** A compaction that would save fewer tokens than this is skipped, unless the prompt no longer fits at all. */
  minSavingTokens: number;
  /**
   * Turns that must pass after a compaction before the next one, unless the prompt no longer fits. Stops a run whose
   * recent rounds alone sit above `compactAt` from compacting (and rewriting its cached prefix) on every turn.
   */
  minTurnsBetween: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = { compactAt: 0.75, compactTo: 0.45, keepRecent: 4, minSavingTokens: 500, minTurnsBetween: 3 };

const policySchema = z.object({
  compactAt: z.number().gt(0).lte(1),
  compactTo: z.number().gt(0).lt(1),
  // The latest round must stay verbatim: providers want the last assistant turn (and its thinking) as sent.
  keepRecent: z.number().int().min(1),
  minSavingTokens: z.number().int().nonnegative(),
  minTurnsBetween: z.number().int().nonnegative(),
}).strict().refine(({ compactAt, compactTo }) => compactTo < compactAt, { message: 'compactTo must be below compactAt', path: ['compactTo'] });

export interface ParseCompactionPolicyParams {
  agentName: string;
  policy: Partial<CompactionPolicy> | undefined;
}

/** The agent's `compaction` over the defaults, validated (0 < compactTo < compactAt <= 1); throws `invalid_definition`. */
export function parseCompactionPolicy(params: ParseCompactionPolicyParams): CompactionPolicy {
  const { agentName, policy } = params;
  const defined = Object.fromEntries(Object.entries(policy ?? {}).filter(([, value]) => value !== undefined));
  const result = policySchema.safeParse({ ...DEFAULT_COMPACTION_POLICY, ...defined });
  if (!result.success) {
    throw createAigentError({ code: 'invalid_definition', message: `Agent '${agentName}' has an invalid compaction policy: ${describeIssues(result.error)}`, details: { agentName } });
  }
  return result.data;
}
