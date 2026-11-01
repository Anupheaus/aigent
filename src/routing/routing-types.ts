import type { RandomSource } from '../core/runtime-services.js';
import type { RunRecord } from '../telemetry/run-record.js';

/** How long the task's text is (task plus context), in characters: short < 200 <= medium < 1,000 <= long. */
export type LengthBucket = 'short' | 'medium' | 'long';

/** The kinds of work the task's words name, from a small fixed lexicon. */
export type KeywordClass = 'search' | 'edit' | 'analyse' | 'summarise';

/** Deterministic features of a task, used to group similar tasks for routing statistics. */
export interface TaskFeatures {
  length: LengthBucket;
  hasPlan: boolean;
  acceptanceCriteria: number;
  hasOutputSchema: boolean;
  toolCount: number;
  unattended: boolean;
  label?: string;
  /** Sorted, unique. */
  keywordClasses: KeywordClass[];
}

/** An agent's models by role: `default` is used unless a priority or the learned statistics pick another. */
export interface ModelRoutes {
  /** `provider:model`. */
  default: string;
  /** A cheaper model, chosen for `routingPriority: 'cost'` once its success is proven close to the best. */
  cheap?: string;
  /** The most capable model, always chosen for `routingPriority: 'quality'`. */
  capable?: string;
  /** Tried in order when the chosen model is exhausted (replaces the definition's `fallbackModels`). */
  fallback?: string[];
}

/** The task's hint for model choice. */
export type RoutingPriority = 'speed' | 'cost' | 'quality';

/** Why a model was chosen. */
export type RouteReason = 'default' | 'priority-quality' | 'priority-cost' | 'learned' | 'explore';

/** One model's record in a feature bucket. */
export interface RouteAlternative {
  model: string;
  /** Weighted success rate (user verdicts outweigh agent claims); 0 without runs. */
  successRate: number;
  /** Mean cost of its priced runs; 0 when none was priced. */
  meanCostUsd: number;
  /** Runs counted. */
  n: number;
}

/** Why the decision went the way it did: the numbers it rested on. */
export interface RouteEvidence {
  /** The feature bucket the statistics are for. */
  bucket: string;
  minSamples: number;
  /** Learned routing for the bucket is cooling down after a revert (runs left). */
  cooldownRunsLeft?: number;
  /** This decision reverted the bucket's learned model, which degraded. */
  reverted?: { model: string; earlierRate: number; recentRate: number };
  /** `priority-cost`: the cheap model's lower confidence bound and the bar it cleared. */
  lowerBound?: number;
  bar?: number;
}

/** An explainable routing decision, stored on the run record as `route`. */
export interface RouteDecision {
  model: string;
  reason: RouteReason;
  evidence?: RouteEvidence;
  /** Every routed model's statistics in the bucket, sorted by model. */
  alternatives: RouteAlternative[];
}

/** `createAigent({ learning: { routing } })`: learned routing between an agent's `ModelRoutes`. */
export interface RoutingOptions {
  /** Runs each model needs in a bucket before learned choices start (default 20). */
  minSamples?: number;
  /** Success-rate points subtracted per unit of relative cost (default 0.1). */
  costWeight?: number;
  /**
   * `routingPriority: 'cost'`: the cheap model's lower bound must reach this share of the best proven rate (default
   * 0.85). Applies only once the cheap and the default model both have `minSamples` runs.
   */
  minSuccessRate?: number;
  /** Largest share of runs sent to a model to learn about it (default 0.1). Never for quality or unattended tasks. */
  maxExploration?: number;
  /** Recent runs compared against the learned model's earlier rate (default 30). */
  window?: number;
  /** Drop in success rate that reverts a learned choice when it is also significant (default 0.1). */
  revertDrop?: number;
  /** Runs of the bucket that stay on `default` after a revert (default 50). */
  cooldownRuns?: number;
  /** Seed for exploration choices, so they are reproducible (default: the runtime's `random`). */
  seed?: number;
}

/** Routing options with defaults filled in. */
export type ResolvedRoutingOptions = Required<Omit<RoutingOptions, 'seed'>>;

export interface ChooseRouteParams {
  agentName: string;
  agentVersion: string;
  features: TaskFeatures;
  priority?: RoutingPriority;
  routes: ModelRoutes;
  now: number;
}

/** Picks a model for each routed run, from its routes and the stored outcomes of earlier runs. */
export interface ModelRouter {
  choose(params: ChooseRouteParams): Promise<RouteDecision>;
  /** Forgets reverts, cooldowns and probations (all agents, or one), so learned routing starts again from the stored statistics. */
  reset(agentName?: string): void;
}

/** What a router needs from its runtime. */
export interface CreateModelRouterParams {
  /** Absent: only the priority rules and `default` apply (learning off). */
  options?: RoutingOptions;
  random: RandomSource;
  /** The stored run records (none without a store). */
  readRuns(): Promise<RunRecord[]>;
  /** A run's cost, undefined when its model has no price (`createAigent({ pricing })`). */
  price?(run: RunRecord): number | undefined;
}
