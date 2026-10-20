import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';

/** Store collection of compressed texts, keyed by `compressText`'s cache key. */
export const COMPRESSED_COLLECTION = 'compressed';
/** Write-queue key for compressed entries; they are written once and never updated. */
const QUEUE_KEY = 'compressed';

/** One cached compression. */
export interface CompressedEntry {
  /** What to send: the compressed text, or the original when the compressor's output was rejected. */
  text: string;
  /** The compressor's output was rejected (or it failed); `text` is the original. */
  isRejected: boolean;
  compressorId: string;
  compressorVersion: string;
  /** Epoch ms; `ai.purge({ before })` compares against it. */
  recordedAt: number;
}

export interface CompressionCache {
  get(key: string): Promise<CompressedEntry | undefined>;
  /** Stores an entry unless one exists already (entries for a key are always identical). */
  set(params: { key: string; entry: CompressedEntry }): Promise<void>;
}

export interface CreateCompressionCacheParams {
  store: Store;
  writeQueue: WriteQueue;
}

/** Compressed texts kept in the store, so restored instances and other runtimes send byte-identical prompts. */
export function createCompressionCache(params: CreateCompressionCacheParams): CompressionCache {
  const { store, writeQueue } = params;
  return {
    get: async key => {
      try {
        return (await store.get<CompressedEntry>(COMPRESSED_COLLECTION, key))?.value;
      } catch {
        // A store that cannot be read only costs a recompression; it must not fail the run.
        return undefined;
      }
    },
    set: ({ key, entry }) => writeQueue.enqueue(QUEUE_KEY, async () => {
      try {
        // A concurrent writer of the same key wrote the same bytes, so losing the race is fine.
        await store.compareAndSet({ collection: COMPRESSED_COLLECTION, key, expectedVersion: undefined, value: entry });
      } catch {
        // Not cached this time; the deterministic compressor gives the same bytes on the next miss.
      }
    }),
  };
}
