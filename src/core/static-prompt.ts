import { compressPersona } from '../compression/compress-prompt.js';
import type { CompressedPart, FieldOutcome, PromptCompressionContext } from '../compression/compress-prompt.js';
import { createAigentError } from './aigent-error.js';
import { raceSignal } from './race-signal.js';
import type { PromptPersona } from './system-prompt.js';

/** The agent's compressed persona, waited for within a caller's signal. */
export type StaticPrompt = (signal?: AbortSignal) => Promise<CompressedPart<PromptPersona>>;

interface MemoEntry {
  promise: Promise<CompressedPart<PromptPersona>>;
  /** Tells the compressor to stop once every waiter has given up. */
  controller: AbortController;
  waiters: number;
}

/** A later use of the memo pays nothing: it is a cache hit with no latency. */
function asMemoHit(fields: FieldOutcome[]): FieldOutcome[] {
  return fields.map(field => (field.result == null ? field : { ...field, result: { ...field.result, cacheHit: true, latencyMs: 0 } }));
}

/** A failed field (the compressor threw or timed out) must be retried by the next run, not served for the agent's life. */
function hasFailedField(part: CompressedPart<PromptPersona>): boolean {
  return part.fields.some(({ result }) => result?.isFailed === true);
}

/**
 * The agent's persona fields, compressed on first use and memoised for the agent's lifetime (`ai.agent` is
 * synchronous, so compression cannot happen at definition time). The store-backed cache makes other agents and
 * runtimes with the same definition reuse the result. The first caller sees the real latency and cache outcome.
 * Only a clean result is memoised: a failure, a rejection or a compression every waiter gave up on (their signals
 * aborted) is dropped, so the next run starts afresh, and an abandoned compressor is told to stop.
 */
export function memoiseStaticPrompt(params: { prompt: PromptPersona; context: PromptCompressionContext }): StaticPrompt {
  const { prompt, context } = params;
  let memo: MemoEntry | undefined;
  let served = 0;
  const start = (): MemoEntry => {
    const controller = new AbortController();
    const entry: MemoEntry = { controller, waiters: 0, promise: compressPersona({ persona: prompt, context: { ...context, signal: controller.signal } }) };
    const forget = (): void => { if (memo === entry) memo = undefined; };
    entry.promise.then(part => { if (hasFailedField(part)) forget(); }, forget);
    return entry;
  };
  return async signal => {
    memo ??= start();
    const entry = memo;
    entry.waiters += 1;
    try {
      const raced = signal == null ? { isAborted: false as const, value: await entry.promise } : await raceSignal({ work: entry.promise, signal });
      if (raced.isAborted) throw createAigentError({ code: 'aborted', message: `Prompt compression was abandoned: ${String(signal?.reason)}` });
      served += 1;
      return served === 1 ? raced.value : { ...raced.value, fields: asMemoHit(raced.value.fields) };
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && signal?.aborted === true && memo === entry) {
        memo = undefined;
        entry.controller.abort('every run waiting for it was stopped');
      }
    }
  };
}
