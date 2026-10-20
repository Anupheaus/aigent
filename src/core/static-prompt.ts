import { compressPersona } from '../compression/compress-prompt.js';
import type { CompressedPart, FieldOutcome, PromptCompressionContext } from '../compression/compress-prompt.js';
import type { PromptPersona } from './system-prompt.js';

/** A later use of the memo pays nothing: it is a cache hit with no latency. */
function asMemoHit(fields: FieldOutcome[]): FieldOutcome[] {
  return fields.map(field => (field.result == null ? field : { ...field, result: { ...field.result, cacheHit: true, latencyMs: 0 } }));
}

/**
 * The agent's persona fields, compressed on first use and memoised for the agent's lifetime (`ai.agent` is
 * synchronous, so compression cannot happen at definition time). The store-backed cache makes other agents and
 * runtimes with the same definition reuse the result. The first caller sees the real latency and cache outcome.
 */
export function memoiseStaticPrompt(params: { prompt: PromptPersona; context: PromptCompressionContext }): () => Promise<CompressedPart<PromptPersona>> {
  const { prompt, context } = params;
  let memo: Promise<CompressedPart<PromptPersona>> | undefined;
  let served = 0;
  return async () => {
    memo ??= compressPersona({ persona: prompt, context });
    const part = await memo;
    served += 1;
    return served === 1 ? part : { ...part, fields: asMemoHit(part.fields) };
  };
}
