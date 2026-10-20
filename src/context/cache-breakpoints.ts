import type { ContextMessage } from './context-message.js';

export interface CacheBreakpointsParams {
  state: readonly ContextMessage[];
  /** Whether the request ends in a volatile block (the last stored message is then the end of the stable prefix). */
  hasVolatile: boolean;
}

/** Index of the last message of the leading non-compactable block (the summary ends that block). */
function leadingBlockEnd(state: readonly ContextMessage[]): number {
  const firstOther = state.findIndex(({ compactable, kind }) => compactable || kind === 'summary');
  return (firstOther === -1 ? state.length : firstOther) - 1;
}

/**
 * Indices into the stored messages after which a provider should set a prompt-cache breakpoint: the end of the system
 * block, the end of the non-compactable block, the summary, and (with a volatile block) the last stable message.
 * These are the four places the prefix can stop being shared, so each cached segment is reused as long as possible.
 */
export function cacheBreakpoints(params: CacheBreakpointsParams): number[] {
  const { state, hasVolatile } = params;
  const lastSystem = state.map(({ kind }) => kind).lastIndexOf('system');
  const summary = state.findIndex(({ kind }) => kind === 'summary');
  const candidates = [lastSystem, leadingBlockEnd(state), summary, hasVolatile ? state.length - 1 : -1];
  return [...new Set(candidates.filter(index => index >= 0))].sort((left, right) => left - right);
}
