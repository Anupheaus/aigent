import { wilsonLowerBound } from '../scoring/stats.js';
import { chooseArm } from './bandit.js';
import { routedModels } from './model-routes.js';
import { degradation, routeArms, toAlternative, toBanditArm } from './routing-stats.js';
import type { ArmRecord } from './routing-stats.js';
import type {
  ChooseRouteParams, CreateModelRouterParams, ModelRouter, ResolvedRoutingOptions, RouteDecision, RouteEvidence, RoutingOptions,
} from './routing-types.js';
import { featureBucket } from './task-features.js';

export const DEFAULT_ROUTING_OPTIONS: ResolvedRoutingOptions = {
  minSamples: 20, costWeight: 0.1, minSuccessRate: 0.85, maxExploration: 0.1, window: 30, revertDrop: 0.1, cooldownRuns: 50,
};

const KEY_SEPARATOR = '\u0000';

export function resolveRoutingOptions(options: RoutingOptions | undefined): ResolvedRoutingOptions {
  const defined = Object.fromEntries(Object.entries(options ?? {}).filter(([key, value]) => value !== undefined && key !== 'seed'));
  return { ...DEFAULT_ROUTING_OPTIONS, ...defined };
}

interface DecideParams {
  choose: ChooseRouteParams;
  arms: ArmRecord[];
  options: ResolvedRoutingOptions;
  evidence: RouteEvidence;
}

/** A bucket's last revert. */
interface RevertState {
  model: string;
  /** The reverted model's outcomes at the revert: they never decide another revert. */
  judgedOutcomes: number;
  /** Runs of the bucket still kept on `default`. */
  runsLeft: number;
}

/** The cheap model when its lower confidence bound reaches `minSuccessRate` of the best proven rate. */
function costChoice(params: DecideParams): RouteDecision | undefined {
  const { choose: { routes: { cheap } }, arms, options: { minSamples, minSuccessRate }, evidence } = params;
  const cheapArm = arms.find(({ model }) => model === cheap);
  if (cheapArm == null || cheapArm.outcomes.length < minSamples) return undefined;
  const proven = arms.filter(({ outcomes }) => outcomes.length >= minSamples).map(toAlternative);
  const bar = minSuccessRate * Math.max(...proven.map(({ successRate }) => successRate));
  const { successes, trials } = toBanditArm(cheapArm);
  const lowerBound = wilsonLowerBound({ successes, n: trials });
  if (lowerBound < bar) return undefined;
  return { model: cheapArm.model, reason: 'priority-cost', evidence: { ...evidence, lowerBound, bar }, alternatives: arms.map(toAlternative) };
}

/** Creates the runtime's router: priority rules always; learned and exploratory choices only with `options`. */
export function createModelRouter(params: CreateModelRouterParams): ModelRouter {
  const { random, readRuns, price } = params;
  const isLearning = params.options != null;
  const options = resolveRoutingOptions(params.options);
  /** Per agent and bucket: the last revert, and the runs it still keeps on `default`. */
  const cooldowns = new Map<string, RevertState>();

  async function choose(choice: ChooseRouteParams): Promise<RouteDecision> {
    const { agentName, features, priority, routes } = choice;
    const bucket = featureBucket(features);
    const arms = routeArms({ runs: await readRuns(), agentName, bucket, models: routedModels(routes), ...(price == null ? {} : { price }) });
    const alternatives = arms.map(toAlternative);
    const evidence: RouteEvidence = { bucket, minSamples: options.minSamples };
    const decision = (model: string, reason: RouteDecision['reason'], extra: Partial<RouteEvidence> = {}): RouteDecision => ({ model, reason, evidence: { ...evidence, ...extra }, alternatives });
    if (priority === 'quality') return decision(routes.capable ?? routes.default, 'priority-quality');
    const decide = { choose: choice, arms, options, evidence };
    if (priority === 'cost') {
      const cheap = costChoice(decide);
      if (cheap != null) return cheap;
    }
    if (!isLearning) return decision(routes.default, 'default');
    const key = `${agentName}${KEY_SEPARATOR}${bucket}`;
    const lastRevert = cooldowns.get(key);
    if (lastRevert != null && lastRevert.runsLeft > 0) {
      const runsLeft = lastRevert.runsLeft - 1;
      cooldowns.set(key, { ...lastRevert, runsLeft });
      return decision(routes.default, 'default', { cooldownRunsLeft: runsLeft });
    }
    const unproven = arms.filter(({ outcomes }) => outcomes.length < options.minSamples);
    // Exploration is bounded and never risks a task nobody is watching.
    if (unproven.length > 0) {
      if (features.unattended || random() >= options.maxExploration) return decision(routes.default, 'default');
      const [leastTried] = [...unproven].sort((left, right) => left.outcomes.length - right.outcomes.length || (left.model < right.model ? -1 : 1));
      return decision((leastTried as ArmRecord).model, 'explore');
    }
    const learned = chooseArm({ arms: arms.map(toBanditArm), costWeight: options.costWeight });
    const learnedArm = arms.find(({ model }) => model === learned) as ArmRecord;
    // After a cooldown the reverted model is on probation: it runs again, and only runs after the revert can revert it again.
    const judgedOutcomes = lastRevert?.model === learned ? lastRevert.judgedOutcomes : 0;
    const dropped = degradation({ outcomes: learnedArm.outcomes, window: options.window, minSamples: options.minSamples, revertDrop: options.revertDrop, judgedOutcomes });
    if (dropped != null) {
      cooldowns.set(key, { model: learned, judgedOutcomes: learnedArm.outcomes.length, runsLeft: options.cooldownRuns });
      return decision(routes.default, 'default', { reverted: { model: learned, ...dropped }, cooldownRunsLeft: options.cooldownRuns });
    }
    return decision(learned, 'learned');
  }

  return {
    choose,
    reset: agentName => {
      if (agentName == null) { cooldowns.clear(); return; }
      for (const key of [...cooldowns.keys()]) if (key.startsWith(`${agentName}${KEY_SEPARATOR}`)) cooldowns.delete(key);
    },
  };
}
