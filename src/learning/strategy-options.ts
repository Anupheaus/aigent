import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { ResolvedStrategyOptions } from './strategy-types.js';

export const DEFAULT_STRATEGY_OPTIONS: ResolvedStrategyOptions = {
  trialShare: 0.2, minSamples: 30, alpha: 0.05, maxEfficiencyRegression: 0.1, tolerance: 0.05, window: 30, maxTrialRuns: 300, seed: 0,
};

const fraction = z.number().min(0).max(1);
const positive = z.number().int().positive();
const optionsSchema = z.object({
  trialShare: fraction.optional(), minSamples: positive.optional(), alpha: z.number().gt(0).lt(1).optional(), maxEfficiencyRegression: z.number().min(0).optional(),
  tolerance: fraction.optional(), window: positive.optional(), maxTrialRuns: positive.optional(), seed: z.number().int().optional(),
}).strict();

/** `learning.strategy` validated with defaults filled in (throws `invalid_input`). */
export function resolveStrategyOptions(options: unknown): ResolvedStrategyOptions {
  const parsed = optionsSchema.safeParse(options ?? {});
  if (!parsed.success) throw createAigentError({ code: 'invalid_input', message: `Invalid learning.strategy options: ${describeIssues(parsed.error)}` });
  const defined = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_STRATEGY_OPTIONS, ...defined };
}
