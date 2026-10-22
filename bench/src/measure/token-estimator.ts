/** Characters per token: the library's estimator (`ceil(chars / 4)`), fixed for the bench so rounds stay comparable. */
export const BENCH_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BENCH_CHARS_PER_TOKEN);
}

/** Tokens of a whole model request as sent (every message and every tool schema, serialised as JSON). */
export function requestTokens(request: { messages: unknown[]; tools: unknown[] }): number {
  return estimateTokens(JSON.stringify(request.messages)) + estimateTokens(JSON.stringify(request.tools));
}
