import { applyToolOverlay, buildOverlay, strategySection } from '../learning/apply-variant.js';
import type { RunStrategyRecord } from '../learning/strategy-types.js';
import { extractTaskFeatures, featureBucket } from '../routing/task-features.js';
import type { Tool } from '../tools/tool-types.js';
import { withLearnedVersion } from './agent-version.js';
import type { ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { SystemPromptOverlay } from './system-prompt.js';
import type { TaskInput } from './task-input.js';

/** What a run takes from what its agent learned. */
export interface LearnedRun {
  /** Agents with `strategy: true`: stored on the run record. */
  strategy?: RunStrategyRecord;
  overlay: SystemPromptOverlay;
  /** The run's tools with learned descriptions applied. */
  tools(base: Tool[]): Tool[];
  /** The agent version with the learned parts included (the plain version when nothing applies). */
  agentVersion: string;
  warnings: string[];
}

export interface PrepareLearnedRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  input: TaskInput;
  runId: string;
  toolCount: number;
}

/** The run's learned overlays; undefined when the agent learns nothing (its prompt and tools are then exactly its own). */
export async function prepareLearnedRun(params: PrepareLearnedRunParams): Promise<LearnedRun | undefined> {
  const { agent, services, input, runId, toolCount } = params;
  const strategy = agent.isStrategyEnabled === true ? services.strategy : undefined;
  if (strategy == null) return undefined;
  const bucket = featureBucket(extractTaskFeatures(input, toolCount));
  const prepared = await strategy.prepareRun({ agentName: agent.name, runId, bucket });
  const overlay = buildOverlay({ variants: prepared.applied, redactsPii: services.redactsPii ?? false });
  const section = strategySection(overlay.rules);
  return {
    strategy: prepared.record,
    overlay: section == null ? {} : { afterRules: [section] },
    tools: base => applyToolOverlay({ tools: base, overlay }),
    agentVersion: withLearnedVersion({ agentVersion: agent.agentVersion, variants: prepared.applied.map(({ id, changes }) => ({ id, changes })) }),
    warnings: overlay.skipped,
  };
}
