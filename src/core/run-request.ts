import { assembleRequest } from '../context/assemble-request.js';
import { calibrate, estimateMessageTokens, estimatePromptTokens } from '../context/estimate-prompt-tokens.js';
import type { ProviderToolSpec } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';
import type { ProviderTarget, TurnRequest } from './open-turn-stream.js';
import type { RunContext } from './run-context.js';
import { volatileText } from './run-volatile.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';

export interface BuildTurnRequestParams {
  context: RunContext;
  tools: ProviderToolSpec[];
  volatile: RunVolatile;
  clock: Clock;
  /** The run's primary model; fallbacks get the same messages with their own model and settings. */
  target: ProviderTarget;
  /** The run's usable prompt budget; a built request estimated above it is never sent. */
  usableBudget: number;
  /** Turn number of this request and tool calls started so far. */
  progress: { turn: number; toolCalls: number; maxToolCalls: number };
}

export interface BuiltTurnRequest {
  request: TurnRequest;
  /** Uncalibrated estimate of the whole prompt, compared with the provider's count once it reports usage. */
  estimatedTokens: number;
}

/**
 * The turn's request: the stored messages in stored order, the volatile block last, cache breakpoints at the layout
 * boundaries. The stable part is checked for prefix stability against the previous request. Throws `context_overflow`
 * when the built request (volatile block included, which compaction could only estimate) is over the usable budget.
 */
export function buildTurnRequest(params: BuildTurnRequestParams): BuiltTurnRequest {
  const { context, tools, volatile, clock, target: { model, settings }, usableBudget, progress } = params;
  const { state } = context;
  const text = volatileText({ volatile, clock, progress });
  context.volatileTokens = text == null ? 0 : estimateMessageTokens({ role: 'user', text });
  const { request, prefixLength } = assembleRequest({ state, tools, model, ...(settings == null ? {} : { settings }), ...(text == null ? {} : { volatile: text }) });
  const { messages, cacheBreakpoints } = request;
  const estimatedTokens = estimatePromptTokens(request);
  const tokens = Math.ceil(estimatedTokens * context.ratio);
  if (tokens > usableBudget) {
    throw createAigentError({ code: 'context_overflow', message: `Context overflow: the request needs ~${tokens} tokens but only ${usableBudget} are usable (the volatile block grew after compaction); raise contextSize or shorten the volatile sections`, details: { tokens, usableBudget, volatileTokens: context.volatileTokens } });
  }
  volatile.monitor.observe({ messages: messages.slice(0, prefixLength), tools });
  return { request: { messages, tools, ...(cacheBreakpoints == null ? {} : { cacheBreakpoints }) }, estimatedTokens };
}

export interface RecordPromptSizeParams {
  context: RunContext;
  estimatedTokens: number;
  /** The provider's `inputTokens` for this request; undefined (or 0) when it reported none. */
  reportedTokens?: number;
}

/** Updates the calibration and the run's peak prompt size once a request has been answered. */
export function recordPromptSize(params: RecordPromptSizeParams): void {
  const { context, estimatedTokens, reportedTokens = 0 } = params;
  const promptTokens = reportedTokens > 0 ? reportedTokens : Math.ceil(estimatedTokens * context.ratio);
  if (reportedTokens > 0) context.ratio = calibrate({ estimated: estimatedTokens, reported: reportedTokens });
  context.peakTokens = Math.max(context.peakTokens, promptTokens);
}
