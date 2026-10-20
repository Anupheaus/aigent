import { previewFields } from '../compression/compress-prompt.js';
import type { PromptPreview } from '../compression/compressor-types.js';
import { estimatePromptTokens } from '../context/estimate-prompt-tokens.js';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import { buildPromptTexts } from './prompt-texts.js';
import { setUpRunPlanning } from './run-planning-setup.js';
import { createRunOriginals } from './run-originals.js';
import { setUpRunShaping } from './run-shaping.js';
import { promptCompressionContext } from './run-settings.js';
import type { ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { TaskInput } from './task-input.js';

export interface PreviewPromptParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  /** Already validated; absent previews the agent alone (empty brief, no plan tools). */
  input?: TaskInput;
}

/** The tool specs a run of this input would start with, built exactly as a run builds its registry. */
function previewTools(params: { agent: ResolvedAgent; input?: TaskInput }): ProviderToolSpec[] {
  const { agent, input } = params;
  const settings = input?.shapers ?? agent.shapers;
  const shaped = setUpRunShaping({ registry: agent.registry, settings, isFeedbackEnabled: agent.feedbackCollector != null });
  // Planning only adds tools here; its events have nowhere to go in a preview.
  const { registry } = setUpRunPlanning({ registry: shaped.registry, input: input ?? { task: '' }, isTodoEnabled: agent.isTodoEnabled, emit: () => undefined });
  const { compression, feedbackCollector } = agent;
  const { shaping } = shaped;
  const originals = createRunOriginals({ registry, isFeedbackEnabled: feedbackCollector != null, ...(shaping == null ? {} : { shaping }), ...(compression == null ? {} : { compression }) });
  return originals.registry().specs();
}

/** What the model would see first for `input`: system prompt, brief and tools, with every compressed field. No provider call. */
export async function previewPrompt(params: PreviewPromptParams): Promise<PromptPreview> {
  const { agent, services, input } = params;
  const { system, brief, fields } = await buildPromptTexts({ staticPrompt: agent.staticPrompt, context: promptCompressionContext({ agent, services }), ...(input == null ? {} : { input }) });
  const tools = previewTools({ agent, ...(input == null ? {} : { input }) });
  const messages: ProviderMessage[] = [{ role: 'system', text: system }, ...(brief === '' ? [] : [{ role: 'user' as const, text: brief }])];
  return { system, brief, tools, fields: previewFields(fields), totalTokens: estimatePromptTokens({ messages, tools }) };
}
