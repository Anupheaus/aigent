/** Output tokens reserved when `maxOutputTokens` is not set... */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096;
/** ...but never more than this share of a small window, which would otherwise leave no room for any prompt. */
const MAX_DEFAULT_RESERVE_SHARE = 0.25;

export interface ContextBudgetParams {
  /** `modelSettings.contextSize`, when set. */
  contextSize?: number;
  /** The provider's published context window. */
  maxContextTokens: number;
  maxOutputTokens?: number;
}

export interface ContextBudget {
  /** The window the run plans for. */
  contextSize: number;
  /** What a prompt may use: the window minus the reserved output. Never negative. */
  usable: number;
}

/**
 * `contextSize ?? maxContextTokens`, less the output reserve: `maxOutputTokens` when set, else 4,096 capped at a
 * quarter of the window.
 */
export function resolveContextBudget(params: ContextBudgetParams): ContextBudget {
  const { contextSize = params.maxContextTokens, maxOutputTokens } = params;
  const reserved = maxOutputTokens ?? Math.min(DEFAULT_RESERVED_OUTPUT_TOKENS, Math.floor(contextSize * MAX_DEFAULT_RESERVE_SHARE));
  return { contextSize, usable: Math.max(0, contextSize - reserved) };
}
