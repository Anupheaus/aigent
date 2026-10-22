import type { ToolCache } from '../cache/cache-types.js';
import type { CompressionCache } from '../compression/compression-cache.js';
import { compressionVersionInput, parseCompressionOptions } from '../compression/compression-options.js';
import { parseCompactionPolicy } from '../context/compaction-policy.js';
import { createFeedbackCollector } from '../feedback/feedback-collector.js';
import { resolveEnableFeedback } from '../feedback/resolve-enable-feedback.js';
import { parseAgentShapers } from '../shapers/shapers-setting.js';
import { createAigentError } from './aigent-error.js';
import type { AgentDefinition } from './agent-types.js';
import { computeAgentVersion } from './agent-version.js';
import { buildAgentRegistry } from './build-agent-registry.js';
import { LIBRARY_VERSION } from './library-version.js';
import { parseModelSettings } from './model-settings.js';
import type { ModelSettings } from './model-settings.js';
import type { TargetResolver } from './model-targets.js';
import { parseResiliencePolicy } from './resilience-policy.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import type { Clock, IdGenerator } from './runtime-services.js';
import type { ResolvedAgent } from './start-task-run.js';
import { memoiseStaticPrompt } from './static-prompt.js';
import { parseAgentLimits } from './task-input.js';

/** What resolving an agent needs from its runtime. */
export interface AgentResolutionContext {
  resolveTarget: TargetResolver;
  /** `createAigent({ modelSettings })`. */
  runtimeSettings?: ModelSettings;
  /** `createAigent({ enableFeedback })`. */
  enableFeedback?: boolean;
  clock: Clock;
  ids: IdGenerator;
  toolCache?: ToolCache;
  compressionCache: CompressionCache;
}

/** Validates a definition (throws `invalid_definition` / `unknown_provider`) into the agent every run of it uses. */
export function resolveAgent(params: { definition: AgentDefinition; context: AgentResolutionContext }): ResolvedAgent {
  const { definition, context: { resolveTarget, runtimeSettings, clock, ids, toolCache, compressionCache } } = params;
  const { name, persona, skillset, context, tools = [], version, fallbackModels, resilience } = definition;
  // process is absent outside Node (e.g. edge runtimes); without it no NODE_ENV is set.
  const env = typeof process === 'undefined' ? {} : process.env;
  const enableFeedback = resolveEnableFeedback({ explicit: definition.enableFeedback ?? params.context.enableFeedback, env });
  if (name === '') throw createAigentError({ code: 'invalid_definition', message: 'Agent name must be a non-empty string' });
  const limits = parseAgentLimits({ agentName: name, limits: definition.limits });
  const agentSettings = parseModelSettings({ owner: `Agent '${name}'`, settings: definition.modelSettings });
  const policy = parseResiliencePolicy({ agentName: name, resilience });
  const shapers = parseAgentShapers({ agentName: name, shapers: definition.shapers });
  const target = resolveTarget(definition.model);
  const fallbackTargets = (fallbackModels ?? []).map(resolveTarget);
  const compaction = parseCompactionPolicy({ agentName: name, policy: definition.compaction });
  const compactionTarget = definition.compactionModel == null ? undefined : resolveTarget(definition.compactionModel);
  const compression = parseCompressionOptions({ agentName: name, options: definition.compression });
  const instanceId = definition.instanceId ?? ids.next('agent');
  const feedbackCollector = enableFeedback ? createFeedbackCollector() : undefined;
  const registry = buildAgentRegistry({
    agentName: name, tools, now: () => clock.now(),
    ...(feedbackCollector == null ? {} : { feedbackCollector }),
    ...(toolCache == null ? {} : { cache: toolCache }),
  });
  const effectiveSettings = resolveModelSettings({ agent: agentSettings, runtime: runtimeSettings, provider: target.providerSettings });
  // A fallback's provider layer can differ from the primary's, so each fallback's own effective settings are hashed.
  const fallbacks = fallbackTargets.map(({ reference, providerSettings }) => ({
    model: reference,
    modelSettings: resolveModelSettings({ agent: agentSettings, runtime: runtimeSettings, provider: providerSettings }),
  }));
  const agentVersion = computeAgentVersion({ libraryVersion: LIBRARY_VERSION, model: target.reference, persona, skillset, context, modelSettings: effectiveSettings, limits, version, tools, fallbacks, resilience: policy, enableFeedback, ...(shapers == null ? {} : { shapers }), ...(definition.todo === false ? { todo: false } : {}),
    ...(definition.compaction == null ? {} : { compaction }),
    ...(compactionTarget == null ? {} : { compactionModel: compactionTarget.reference }),
    ...(compression == null ? {} : { compression: compressionVersionInput(compression) }),
  });
  const toolAddenda = tools.flatMap(({ promptAddendum }) => (promptAddendum == null ? [] : [promptAddendum]));
  const prompt = { persona, skillset, context, enableFeedback, ...(toolAddenda.length === 0 ? {} : { toolAddenda }) };
  const staticPrompt = memoiseStaticPrompt({ prompt, context: { cache: compressionCache, now: () => clock.now(), ...(compression == null ? {} : { compression }) } });
  return { name, instanceId, targets: [target, ...fallbackTargets], resilience: policy, prompt, staticPrompt, registry, limits, agentSettings, runtimeSettings, agentVersion, version,
    ...(feedbackCollector == null ? {} : { feedbackCollector }),
    ...(shapers == null ? {} : { shapers }),
    isTodoEnabled: definition.todo !== false,
    compaction,
    ...(compactionTarget == null ? {} : { compactionTarget }),
    ...(compression == null ? {} : { compression }),
  };
}
