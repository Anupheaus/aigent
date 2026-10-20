import { previewFields } from '../compression/compress-prompt.js';
import type { PromptPreview } from '../compression/compressor-types.js';
import { estimatePromptTokens } from '../context/estimate-prompt-tokens.js';
import { renderPinned } from '../planning/render-pinned.js';
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

/** The tool specs and pinned plan message a run of this input would start with, built exactly as a run builds them. */
function previewSetup(params: { agent: ResolvedAgent; input?: TaskInput }): { tools: ProviderToolSpec[]; pinned?: string } {
  const { agent, input } = params;
  const settings = input?.shapers ?? agent.shapers;
  const shaped = setUpRunShaping({ registry: agent.registry, settings, isFeedbackEnabled: agent.feedbackCollector != null });
  // Planning only adds tools here; its events have nowhere to go in a preview.
  const { registry, planning } = setUpRunPlanning({ registry: shaped.registry, input: input ?? { task: '' }, isTodoEnabled: agent.isTodoEnabled, emit: () => undefined });
  const { compression, feedbackCollector } = agent;
  const { shaping } = shaped;
  const originals = createRunOriginals({ registry, isFeedbackEnabled: feedbackCollector != null, ...(shaping == null ? {} : { shaping }), ...(compression == null ? {} : { compression }) });
  const pinned = renderPinned(planning.state);
  return { tools: originals.registry().specs(), ...(pinned == null ? {} : { pinned }) };
}

/** What the model would see first for `input`: system prompt, brief, pinned plan and tools, with every compressed field. No provider call. */
export async function previewPrompt(params: PreviewPromptParams): Promise<PromptPreview> {
  const { agent, services, input } = params;
  const { system, brief, fields } = await buildPromptTexts({ staticPrompt: agent.staticPrompt, context: promptCompressionContext({ agent, services }), ...(input == null ? {} : { input }) });
  const { tools, pinned } = previewSetup({ agent, ...(input == null ? {} : { input }) });
  const texts = [brief, pinned ?? ''].filter(text => text !== '');
  const messages: ProviderMessage[] = [{ role: 'system', text: system }, ...texts.map(text => ({ role: 'user' as const, text }))];
  return { system, brief, tools, ...(pinned == null ? {} : { pinned }), fields: previewFields(fields), totalTokens: estimatePromptTokens({ messages, tools }) };
}
