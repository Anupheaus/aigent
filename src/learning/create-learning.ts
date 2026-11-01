import { z } from 'zod';
import { createResponseCache, parseResponseCacheOptions } from '../cache/response-cache.js';
import type { ResponseCache } from '../cache/response-cache.js';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { createSeededRandom } from '../core/runtime-services.js';
import type { Clock, IdGenerator, RandomSource } from '../core/runtime-services.js';
import { FEEDBACK_COLLECTION, USER_RATINGS } from '../feedback/feedback-records.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import { createModelRouter } from '../routing/model-router.js';
import type { ModelRouter, RoutingOptions } from '../routing/routing-types.js';
import { costOfUsage } from '../scoring/pricing.js';
import { readReport } from '../scoring/read-report.js';
import type { Pricing } from '../scoring/report-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import { readRunRecords, readRunTraces } from '../telemetry/read-runs.js';
import type { Redact } from '../telemetry/redact.js';
import type { Tool } from '../tools/tool-types.js';
import type { GroupLesson } from './lessons.js';
import type { LearningApi, LearningOptions } from './learning-types.js';
import { createStrategyRecords } from './strategy-store.js';
import { createStrategyRuntime } from './strategy-runtime.js';
import type { StrategyRuntime } from './strategy-runtime.js';
import { createSkillRecords } from './skills/skill-store.js';
import { createSkillRegistry } from './skills/skill-registry.js';
import type { SkillRegistry } from './skills/skill-registry.js';

const fraction = z.number().min(0).max(1);
const positive = z.number().int().positive();
const routingSchema = z.object({
  minSamples: positive.optional(), costWeight: z.number().min(0).optional(), minSuccessRate: fraction.optional(), maxExploration: fraction.optional(),
  window: positive.optional(), revertDrop: fraction.optional(), cooldownRuns: z.number().int().nonnegative().optional(), seed: z.number().int().optional(),
}).strict();
const ratingSchema = z.object({ kind: z.literal('user'), responseId: z.string(), rating: z.enum(USER_RATINGS), comment: z.string().optional(), expectedAnswer: z.string().optional() });

function parseRoutingOptions(options: unknown): RoutingOptions {
  const parsed = routingSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid learning.routing options: ${describeIssues(parsed.error)}` });
}

/** The latest user rating of each response. */
async function readRatings(store: Store | undefined): Promise<Map<string, UserFeedback>> {
  if (store == null) return new Map();
  return new Map((await store.list<unknown>(FEEDBACK_COLLECTION)).flatMap(({ value }) => {
    const parsed = ratingSchema.safeParse(value);
    if (!parsed.success) return [];
    const { responseId, rating, comment, expectedAnswer } = parsed.data;
    return [[responseId, { responseId, rating, ...(comment == null ? {} : { comment }), ...(expectedAnswer == null ? {} : { expectedAnswer }) }] as const];
  }));
}

export interface CreateLearningParams {
  options?: LearningOptions;
  store?: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
  clock: Clock;
  ids: IdGenerator;
  random: RandomSource;
  pricing?: Pricing;
  /** The runtime's pii guardrail redacts: learned text is held to the same rule. */
  redactsPii: boolean;
  /** The tools of an agent defined in this runtime. */
  agentTools(agentName: string): Tool[] | undefined;
  /** Saves a lesson to the agent's memory; undefined without memory. Resolves with a problem, or undefined when saved. */
  saveLesson?(params: { agentName: string; lesson: GroupLesson }): Promise<string | undefined>;
}

/** The runtime's learning parts and the `ai.learning` API over them. */
export interface LearningRuntime {
  router: ModelRouter;
  responseCache?: ResponseCache;
  strategy: StrategyRuntime;
  skills: SkillRegistry;
  api: LearningApi;
}

/** Validates `createAigent({ learning })` (throws `invalid_input`) and builds what it turns on. */
export function createLearning(params: CreateLearningParams): LearningRuntime {
  const { options = {}, store, writeQueue, redact, clock, ids, random, pricing, redactsPii, agentTools, saveLesson } = params;
  const routing = options.routing == null ? undefined : parseRoutingOptions(options.routing);
  const responseCache = options.responseCache == null ? undefined : createResponseCache({ options: parseResponseCacheOptions(options.responseCache), now: () => clock.now() });
  const router = createModelRouter({
    ...(routing == null ? {} : { options: routing }),
    random: routing?.seed == null ? random : createSeededRandom(routing.seed),
    readRuns: () => readRunRecords(store),
    price: run => costOfUsage({ model: run.model, usage: run.usage, ...(pricing == null ? {} : { pricing }) }) ?? undefined,
  });
  // Variants are configuration, not content: they live in the runtime's store (through redact), or in memory without one.
  const records = createStrategyRecords({ store: store ?? createInMemoryStore(), writeQueue, ...(redact == null ? {} : { redact }), now: () => clock.now() });
  const strategy = createStrategyRuntime({
    ...(options.strategy == null ? {} : { options: options.strategy }), records, clock, ids, redactsPii, agentTools,
    readRuns: () => readRunRecords(store), readTraces: () => readRunTraces(store), readRatings: () => readRatings(store),
    findings: async agentName => (await readReport({ store, filter: { agentName }, now: () => clock.now(), ...(pricing == null ? {} : { pricing }) })).findings,
    ...(saveLesson == null ? {} : { saveLesson }),
  });
  const skills = createSkillRegistry({
    records: createSkillRecords({ store: store ?? createInMemoryStore(), writeQueue, ...(redact == null ? {} : { redact }), now: () => clock.now() }),
    clock, ids, redactsPii, agentTools, readTraces: () => readRunTraces(store), ...(options.skills == null ? {} : { options: options.skills }),
  });
  return {
    router, strategy, skills,
    ...(responseCache == null ? {} : { responseCache }),
    api: {
      routing: { reset: agentName => router.reset(agentName) },
      responseCache: { size: () => responseCache?.size() ?? 0, clear: () => responseCache?.clear() },
      strategy: strategy.api,
    },
  };
}
