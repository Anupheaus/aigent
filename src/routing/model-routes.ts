import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { ModelRoutes } from './routing-types.js';

const reference = z.string().min(1);
const routesSchema = z.object({ default: reference, cheap: reference.optional(), capable: reference.optional(), fallback: z.array(reference).optional() }).strict();

/** An agent's `model`: one `provider:model`, or routes validated (throws `invalid_definition`). */
export function parseModelRoutes(params: { agentName: string; model: unknown }): ModelRoutes | undefined {
  const { agentName, model } = params;
  if (typeof model === 'string') return undefined;
  const parsed = routesSchema.safeParse(model);
  if (parsed.success) return parsed.data;
  throw createAigentError({
    code: 'invalid_definition',
    message: `Agent '${agentName}' has an invalid model: expected 'provider:model' or { default, cheap?, capable?, fallback? }: ${describeIssues(parsed.error)}`,
    details: { agentName },
  });
}

/** The distinct models a route set can choose between, default first. */
export function routedModels(routes: ModelRoutes): string[] {
  const { default: base, cheap, capable } = routes;
  return [...new Set([base, ...(cheap == null ? [] : [cheap]), ...(capable == null ? [] : [capable])])];
}

/** The run's models in order: the chosen one, then default (when another was chosen), then the fallbacks. */
export function runModelOrder(params: { routes: ModelRoutes; chosen: string }): string[] {
  const { routes, chosen } = params;
  return [...new Set([chosen, routes.default, ...routes.fallback ?? []])];
}
