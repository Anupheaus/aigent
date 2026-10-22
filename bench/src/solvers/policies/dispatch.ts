import type { SolverAnswer } from '../../task-spec.js';
import type { Policy, PolicyContext } from '../policy-types.js';
import { readPrompt } from '../read-prompt.js';
import type { Intent } from '../read-prompt.js';
import { solveEndpoints, solveRouteTrace } from '../strategies/api.js';
import { solveBugs } from '../strategies/bugs.js';
import { solveCustomerUi, solvePiiFields, solveReact } from '../strategies/classify.js';
import { solveDeadExports, solveTestsFor } from '../strategies/code-map.js';
import { solveFindFile } from '../strategies/find-file.js';
import { solveGdpr } from '../strategies/gdpr.js';
import { solveIdentifier } from '../strategies/identifier.js';
import { solveNoisyCall } from '../strategies/noisy-call.js';
import type { Style } from '../strategies/shared.js';
import { solveAnyCase, solveWord } from '../strategies/text-search.js';
import { solveTheme } from '../strategies/theme.js';

/** One intent's strategy for a style; `undefined` falls back to the Round-0 strategy for that style. */
export type IntentOverride = (params: { ctx: PolicyContext; intent: Intent }) => Promise<SolverAnswer | undefined>;

/** The Round-0 strategy for an intent and style. */
export function solveIntent(params: { ctx: PolicyContext; intent: Intent; style: Style }): Promise<SolverAnswer> {
  const { ctx, intent, style } = params;
  switch (intent.kind) {
    case 'find-file': return solveFindFile({ ctx, name: intent.name, style });
    case 'tests-for': return solveTestsFor({ ctx, module: intent.module, style });
    case 'env-var': return solveIdentifier({ ctx, question: { identifier: intent.name, includeTests: false }, style });
    case 'route-trace': return solveRouteTrace({ ctx, endpoint: intent.endpoint, style });
    case 'symbol': return solveIdentifier({ ctx, question: { identifier: intent.name, includeTests: true }, style });
    case 'string-noisy': return solveNoisyCall({ ctx, verb: intent.verb, style });
    case 'string-any-case': return solveAnyCase({ ctx, identifier: intent.identifier, style });
    case 'string-word': return solveWord({ ctx, word: intent.identifier, style });
    case 'string-usage': return solveIdentifier({ ctx, question: { identifier: intent.identifier, includeTests: false }, style });
    case 'bugs': return solveBugs({ ctx, style });
    case 'gdpr': return solveGdpr({ ctx, style });
    case 'endpoints': return solveEndpoints({ ctx, style });
    case 'theme': return solveTheme({ ctx, style });
    case 'ui-customer': return solveCustomerUi({ ctx, style });
    case 'pii-fields': return solvePiiFields({ ctx, style });
    case 'dead-exports': return solveDeadExports({ ctx, style });
    case 'react': return solveReact({ ctx, style });
  }
}

/** A policy that reads the prompt, then plays `style` (with optional per-intent overrides, used by later rounds). */
export function createPolicy(params: { style: Style; override?: IntentOverride }): Policy {
  const { style, override } = params;
  return async ctx => {
    const intent = readPrompt(ctx.prompt);
    if (intent == null) return { text: 'I could not work out what is being asked.' };
    return (await override?.({ ctx, intent })) ?? solveIntent({ ctx, intent, style });
  };
}
