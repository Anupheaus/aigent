import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { Usage } from '../providers/provider-types.js';
import type { RunRecord } from '../telemetry/run-record.js';
import type { Pricing } from './report-types.js';

const TOKENS_PER_MILLION = 1_000_000;
/** `provider:model`, as run records name models. */
const MODEL_KEY_PATTERN = /^[^:]+:.+$/;

const priceSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
  cachedInputPerMTokUsd: z.number().nonnegative().optional(),
}).strict();

const pricingSchema = z.record(z.string().regex(MODEL_KEY_PATTERN, 'keys must be provider:model'), priceSchema);

/** Validates `createAigent({ pricing })`; throws `invalid_definition` naming each bad field. */
export function parsePricing(pricing: unknown): Pricing | undefined {
  if (pricing === undefined) return undefined;
  const result = pricingSchema.safeParse(pricing);
  if (result.success) return result.data;
  throw createAigentError({ code: 'invalid_definition', message: `Invalid pricing (non-negative USD per million tokens, keyed provider:model): ${describeIssues(result.error)}` });
}

export interface CostOfUsageParams {
  /** `provider:model`. */
  model: string;
  usage: Usage;
  pricing?: Pricing;
}

/** The cost of `usage` at `model`'s price in US dollars, or null without a price for it. */
export function costOfUsage(params: CostOfUsageParams): number | null {
  const { model, usage: { inputTokens, outputTokens, cachedTokens }, pricing } = params;
  const price = pricing?.[model];
  if (price == null) return null;
  const { inputPerMTokUsd, outputPerMTokUsd, cachedInputPerMTokUsd = inputPerMTokUsd } = price;
  // Providers report cached tokens as part of the input, so they are taken out before the full input price applies.
  const cached = Math.min(cachedTokens, inputTokens);
  const uncached = inputTokens - cached;
  return (uncached * inputPerMTokUsd + cached * cachedInputPerMTokUsd + outputTokens * outputPerMTokUsd) / TOKENS_PER_MILLION;
}

export interface CostOfRunParams {
  run: RunRecord;
  pricing?: Pricing;
}

/**
 * The run's cost in US dollars at its primary model's price, or null without one. Usage is not split per model, so a
 * run that used a fallback model is priced as if the primary served it.
 */
export function costOfRun(params: CostOfRunParams): number | null {
  const { run: { model, usage }, pricing } = params;
  return costOfUsage({ model, usage, ...(pricing == null ? {} : { pricing }) });
}
