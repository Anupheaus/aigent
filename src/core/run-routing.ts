import { runModelOrder } from '../routing/model-routes.js';
import type { RouteDecision } from '../routing/routing-types.js';
import { extractTaskFeatures, featureBucket } from '../routing/task-features.js';
import { describeError } from './describe-value.js';
import type { ModelTarget, ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { TaskInput } from './task-input.js';

export interface RouteRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  input: TaskInput;
  /** Tools the run offers (a routing feature). */
  toolCount: number;
  warn(message: string): void;
}

/** A routed run's decision and its models in order (chosen first, then default, then the fallbacks). */
export interface RoutedRun {
  decision: RouteDecision;
  targets: [ModelTarget, ...ModelTarget[]];
}

/**
 * Chooses the model of a routed agent's run (undefined for an agent with one model). When the statistics cannot be
 * read the run uses `default`, says why in a warning, and records the decision as `default`.
 */
export async function routeRun(params: RouteRunParams): Promise<RoutedRun | undefined> {
  const { agent, services: { router, clock }, input, toolCount, warn } = params;
  if (agent.routing == null || router == null) return undefined;
  const { routes, targets } = agent.routing;
  const features = extractTaskFeatures(input, toolCount);
  let decision: RouteDecision;
  try {
    decision = await router.choose({
      agentName: agent.name, agentVersion: agent.agentVersion, features, routes, now: clock.now(),
      ...(input.routingPriority == null ? {} : { priority: input.routingPriority }),
    });
  } catch (error) {
    warn(`Model routing for agent '${agent.name}' could not read its statistics, so the run uses its default model '${routes.default}': ${describeError(error)}`);
    decision = { model: routes.default, reason: 'default', evidence: { bucket: featureBucket(features), minSamples: 0 }, alternatives: [] };
  }
  // The fallbacks were resolved with the agent; only routed models live in `targets`.
  const byReference = new Map([...targets, ...agent.targets.map(target => [target.reference, target] as const)]);
  const ordered = runModelOrder({ routes, chosen: decision.model }).flatMap(reference => { const target = byReference.get(reference); return target == null ? [] : [target]; });
  const [first, ...rest] = ordered;
  return first == null ? undefined : { decision, targets: [first, ...rest] };
}
