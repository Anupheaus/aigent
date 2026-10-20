/** Output tokens reserved when `maxOutputTokens` is not set. */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096;

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

/** `contextSize ?? maxContextTokens`, less the output reserve (`maxOutputTokens ?? 4096`). */
export function resolveContextBudget(params: ContextBudgetParams): ContextBudget {
  const { contextSize = params.maxContextTokens, maxOutputTokens = DEFAULT_RESERVED_OUTPUT_TOKENS } = params;
  return { contextSize, usable: Math.max(0, contextSize - maxOutputTokens) };
}
