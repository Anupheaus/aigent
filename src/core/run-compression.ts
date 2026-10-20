import { compressToolResults } from '../compression/compress-tool-results.js';
import type { CompressedToolResults } from '../compression/compress-tool-results.js';
import type { CompressionCache } from '../compression/compression-cache.js';
import type { ResolvedCompression } from '../compression/compression-options.js';
import type { CompressionRecord } from '../compression/compressor-types.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { AigentEvent } from './aigent-events.js';
import type { RunOriginals } from './run-originals.js';
import type { Clock } from './runtime-services.js';

/** One run's compression: the agent's settings, the shared cache and the run's telemetry log. */
export interface RunCompression {
  settings: ResolvedCompression;
  cache: CompressionCache;
  /** Every compression the run used (prompt fields and tool results), stored on its run record. */
  log: CompressionRecord[];
}

export interface CompressCommittedParams {
  executed: ExecutedToolCall[];
  compression?: RunCompression;
  originals: RunOriginals;
  clock: Clock;
  signal: AbortSignal;
  emit(event: AigentEvent): void;
}

/** A turn's results as they are committed to history: compressible prose compressed, everything else as it was. */
export async function compressCommitted(params: CompressCommittedParams): Promise<ExecutedToolCall[]> {
  const { executed, compression, originals, clock, signal, emit } = params;
  if (compression == null) return executed;
  const { settings, cache, log } = compression;
  let compressed: CompressedToolResults;
  try {
    compressed = await compressToolResults({
      executed, registry: originals.registry(), compression: settings, cache, now: () => clock.now(), keepOriginal: text => originals.keep(text), signal,
    });
  } catch {
    // Only an abort escapes compressToolResults; the loop sees the aborted signal next and ends the run.
    return executed;
  }
  log.push(...compressed.records);
  for (const message of compressed.warnings) emit({ type: 'warning', message });
  return compressed.executed;
}
