import type { ProviderMessage, ProviderRequest } from '../providers/provider-types.js';

/** Rough characters per token used for every prompt estimate. */
export const CHARS_PER_TOKEN = 4;
/** Role markers and separators each message costs on top of its text. */
export const MESSAGE_OVERHEAD_TOKENS = 4;
/** Bounds of the correction ratio learnt from provider-reported input tokens. */
export const MIN_CALIBRATION_RATIO = 0.5;
export const MAX_CALIBRATION_RATIO = 2;

function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Characters a message sends: its text, tool calls and thinking blocks. */
function messageChars(message: ProviderMessage): number {
  const { text = '', toolCalls, thinkingBlocks } = message;
  const callChars = toolCalls == null ? 0 : JSON.stringify(toolCalls).length;
  const thinkingChars = thinkingBlocks == null ? 0 : JSON.stringify(thinkingBlocks).length;
  return text.length + callChars + thinkingChars;
}

/** Estimated tokens of one message, overhead included. */
export function estimateMessageTokens(message: ProviderMessage): number {
  return tokensOf(messageChars(message)) + MESSAGE_OVERHEAD_TOKENS;
}

/** Uncalibrated estimate of a request's prompt: every message plus the tool specs. */
export function estimatePromptTokens(request: Pick<ProviderRequest, 'messages' | 'tools'>): number {
  const { messages, tools } = request;
  const messageTokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  return messageTokens + (tools.length === 0 ? 0 : tokensOf(JSON.stringify(tools).length));
}

export interface CalibrateParams {
  /** What `estimatePromptTokens` said for the request. */
  estimated: number;
  /** The provider's `inputTokens` for the same request. */
  reported: number;
}

/** Ratio that turns an estimate into what the provider counts, clamped so one odd response cannot swing it far. */
export function calibrate(params: CalibrateParams): number {
  const { estimated, reported } = params;
  if (estimated <= 0 || reported <= 0) return 1;
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, reported / estimated));
}
