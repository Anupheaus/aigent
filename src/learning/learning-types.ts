import type { ResponseCacheOptions } from '../cache/response-cache.js';
import type { RoutingOptions } from '../routing/routing-types.js';
import type { StrategyApi, StrategyOptions } from './strategy-types.js';

/** `createAigent({ learning })`: every part is off unless given. Nothing learned bypasses guardrails, approvals or policies. */
export interface LearningOptions {
  /** Learned routing between the `ModelRoutes` of routed agents (priority rules apply without it). */
  routing?: RoutingOptions;
  /** Replays identical reproducible model requests (temperature 0 or a seed) from memory. */
  responseCache?: ResponseCacheOptions;
  /** Tuning of strategy trials, promotion and the rollout guard; agents opt in with `strategy: true`. */
  strategy?: StrategyOptions;
}

/** `ai.learning.routing`. */
export interface RoutingLearningApi {
  /** Forgets reverts and cooldowns (every agent, or one); learned choices restart from the stored statistics. */
  reset(agentName?: string): void;
}

/** `ai.learning.responseCache`. */
export interface ResponseCacheApi {
  /** Entries held. */
  size(): number;
  /** Drops every entry. */
  clear(): void;
}

/** `ai.learning`: inspects and removes what the runtime learned. */
export interface LearningApi {
  routing: RoutingLearningApi;
  responseCache: ResponseCacheApi;
  /** Strategy variants: propose, approve, inspect, revert and remove. */
  strategy: StrategyApi;
}
