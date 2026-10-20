import { createAigentError } from '../core/aigent-error.js';
import type { ProviderRequest, ProviderSettings, ProviderToolSpec } from '../providers/provider-types.js';
import { cacheBreakpoints } from './cache-breakpoints.js';
import { toProviderMessages } from './context-message.js';
import type { ContextMessage } from './context-message.js';

export interface AssembleRequestParams {
  /** The run's stored messages, in stored order. */
  state: readonly ContextMessage[];
  tools: ProviderToolSpec[];
  settings?: ProviderSettings;
  /** The trailing `# Current state` text; sent as the last `user` message, never stored. */
  volatile?: string;
  model: string;
}

export interface AssembledRequest {
  request: ProviderRequest;
  /** How many leading request messages are the stable prefix (everything but the volatile block). */
  prefixLength: number;
}

/**
 * At most one summary, and only non-compactable messages ahead of it. Stored order is append-only between
 * compactions and `applyCompaction` is the only place that reorders, so a breach is a runtime bug, not bad input.
 */
function checkLayout(state: readonly ContextMessage[]): void {
  const summaries = state.filter(({ kind }) => kind === 'summary');
  if (summaries.length > 1) {
    throw createAigentError({ code: 'invalid_input', message: `Context layout holds ${summaries.length} summaries; expected at most one summary`, details: { ids: summaries.map(({ id }) => id) } });
  }
  const summaryIndex = state.findIndex(({ kind }) => kind === 'summary');
  const misplaced = state.slice(0, Math.max(0, summaryIndex)).filter(({ compactable }) => compactable);
  if (misplaced.length > 0) {
    throw createAigentError({ code: 'invalid_input', message: `Context layout has compactable messages before the summary (${misplaced.map(({ id }) => id).join(', ')}); expected only non-compactable ones there`, details: { ids: misplaced.map(({ id }) => id) } });
  }
}

/**
 * The request for the stored messages: stored order as is (`[system][non-compactable][summary][recent]` once a
 * compaction has hoisted it, plain append order before), then the volatile block, with cache breakpoints at the layout
 * boundaries. Never reorders anything, so between compactions each request's prefix extends the previous one.
 */
export function assembleRequest(params: AssembleRequestParams): AssembledRequest {
  const { state, tools, settings, volatile, model } = params;
  checkLayout(state);
  const stable = toProviderMessages(state);
  const messages = volatile == null ? stable : [...stable, { role: 'user' as const, text: volatile, volatile: true }];
  const breakpoints = cacheBreakpoints({ state, hasVolatile: volatile != null });
  const request: ProviderRequest = {
    model, messages, tools,
    ...(settings == null ? {} : { settings }),
    ...(breakpoints.length === 0 ? {} : { cacheBreakpoints: breakpoints }),
  };
  return { request, prefixLength: stable.length };
}
