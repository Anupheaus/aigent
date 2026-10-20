import { estimateMessageTokens } from './estimate-prompt-tokens.js';

export interface ToolResultStubParams {
  tool: string;
  callId: string;
  /** Estimated tokens of the result being omitted. */
  tokens: number;
  /** `result_original` handle the verbatim result is kept under. */
  handle: string;
}

/** What a stale tool result becomes: the tool message stays (pairing intact), its text says how to get it back. */
export function toolResultStub(params: ToolResultStubParams): string {
  const { tool, callId, tokens, handle } = params;
  return `[result of ${tool} call ${callId} omitted to save context (~${tokens} tokens); refetch with result_original handle ${handle}]`;
}

/** What an older copy of an identical tool result becomes. */
export function duplicateResultStub(keptCallId: string): string {
  return `[same result as call ${keptCallId}, kept below]`;
}

/** A handle as wide as any a run will issue, so planned stub sizes are never underestimated. */
const PLANNING_HANDLE = 'H99999';

/** Estimated tokens of the stub that would replace a result, for planning. */
export function stubTokens(params: Omit<ToolResultStubParams, 'handle'>): number {
  return estimateMessageTokens({ role: 'tool', text: toolResultStub({ ...params, handle: PLANNING_HANDLE }) });
}

/** Estimated tokens of a duplicate reference, for planning. */
export function duplicateStubTokens(keptCallId: string): number {
  return estimateMessageTokens({ role: 'tool', text: duplicateResultStub(keptCallId) });
}
