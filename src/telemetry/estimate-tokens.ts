/** Rough characters per token; good enough to compare sizes without a provider tokenizer. */
export const CHARS_PER_TOKEN = 4;

/** Estimated tokens in `text`: one per `CHARS_PER_TOKEN` characters, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
