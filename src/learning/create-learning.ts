import { createResponseCache, parseResponseCacheOptions } from '../cache/response-cache.js';
import type { ResponseCache } from '../cache/response-cache.js';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { createSeededRandom } from '../core/runtime-services.js';
import type { Clock, RandomSource } from '../core/runtime-services.js';
import { createModelRouter } from '../routing/model-router.js';
import type { ModelRouter, RoutingOptions } from '../routing/routing-types.js';
import { costOfUsage } from '../scoring/pricing.js';
import type { Pricing } from '../scoring/report-types.js';
import type { Store } from '../store/store-types.js';
import { readRunRecords } from '../telemetry/read-runs.js';
import { z } from 'zod';
import type { LearningApi, LearningOptions } from './learning-types.js';

const fraction = z.number().min(0).max(1);
const positive = z.number().int().positive();
const routingSchema = z.object({
  minSamples: positive.optional(), costWeight: z.number().min(0).optional(), minSuccessRate: fraction.optional(), maxExploration: fraction.optional(),
  window: positive.optional(), revertDrop: fraction.optional(), cooldownRuns: z.number().int().nonnegative().optional(), seed: z.number().int().optional(),
}).strict();

function parseRoutingOptions(options: unknown): RoutingOptions {
  const parsed = routingSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid learning.routing options: ${describeIssues(parsed.error)}` });
}

export interface CreateLearningParams {
  options?: LearningOptions;
  store?: Store;
  clock: Clock;
  random: RandomSource;
  pricing?: Pricing;
}

/** The runtime's learning parts and the `ai.learning` API over them. */
export interface LearningRuntime {
  router: ModelRouter;
  responseCache?: ResponseCache;
  api: LearningApi;
}

/** Validates `createAigent({ learning })` (throws `invalid_input`) and builds what it turns on. */
export function createLearning(params: CreateLearningParams): LearningRuntime {
  const { options = {}, store, clock, random, pricing } = params;
  const routing = options.routing == null ? undefined : parseRoutingOptions(options.routing);
  const responseCache = options.responseCache == null ? undefined : createResponseCache({ options: parseResponseCacheOptions(options.responseCache), now: () => clock.now() });
  const router = createModelRouter({
    ...(routing == null ? {} : { options: routing }),
    random: routing?.seed == null ? random : createSeededRandom(routing.seed),
    readRuns: () => readRunRecords(store),
    price: run => costOfUsage({ model: run.model, usage: run.usage, ...(pricing == null ? {} : { pricing }) }) ?? undefined,
  });
  return {
    router,
    ...(responseCache == null ? {} : { responseCache }),
    api: {
      routing: { reset: agentName => router.reset(agentName) },
      responseCache: { size: () => responseCache?.size() ?? 0, clear: () => responseCache?.clear() },
    },
  };
}
