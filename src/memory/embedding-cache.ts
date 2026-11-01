import { describeError } from '../core/describe-value.js';
import type { Embedder } from '../knowledge/knowledge-types.js';
import { sha256 } from '../knowledge/vector-index.js';
import type { Store } from '../store/store-types.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry } from './memory-types.js';
import { dropMemoryVectors, readMemoryVector, writeMemoryVector } from './memory-vectors.js';
import type { MemoryVectorRecord } from './memory-vectors.js';
import { scrubMemoryText } from './scrub-memory-text.js';

/** Store reads and writes in flight at once: enough to hide latency, few enough not to swamp a remote store. */
const STORE_CONCURRENCY = 16;

/** An entry with the exact text it is embedded from: its stored text, scrubbed of secrets once more. */
export interface EmbeddableEntry {
  entry: MemoryEntry;
  text: string;
  textHash: string;
}

/** Stored text is already scrubbed; scrubbing again keeps a secret an older writer left out of the embedder. */
export function embeddableOf(entry: MemoryEntry): EmbeddableEntry {
  const text = scrubMemoryText({ text: entry.text });
  return { entry, text, textHash: sha256(text) };
}

async function inBatches<T, R>(params: { items: T[]; run(item: T): Promise<R> }): Promise<R[]> {
  const { items, run } = params;
  const results: R[] = [];
  for (let start = 0; start < items.length; start += STORE_CONCURRENCY) results.push(...await Promise.all(items.slice(start, start + STORE_CONCURRENCY).map(run)));
  return results;
}

/** Whether a stored vector was made by this embedder from exactly this entry's text, in its agent and scope. */
function fits(params: { record: MemoryVectorRecord; embeddable: EmbeddableEntry; embedder: Embedder }): boolean {
  const { record, embeddable: { entry, textHash }, embedder } = params;
  return record.embedderId === embedder.id && record.dimensions === embedder.dimensions && record.vector.length === embedder.dimensions
    && record.agentName === entry.agentName && record.scopeKey === entry.scopeKey && record.textHash === textHash;
}

/** The stored vectors that fit (by entry id); entries missing from the map need embedding. */
export async function loadVectors(params: { store: Store; embeddables: EmbeddableEntry[]; embedder: Embedder }): Promise<Map<string, number[]>> {
  const { store, embeddables, embedder } = params;
  const found = await inBatches({
    items: embeddables,
    run: async embeddable => {
      const record = await readMemoryVector({ store, memoryId: embeddable.entry.id });
      return record != null && fits({ record, embeddable, embedder }) ? [embeddable.entry.id, record.vector] as const : undefined;
    },
  });
  return new Map(found.filter(pair => pair != null));
}

/** Whether the entry is still stored, live and unchanged since it was embedded. */
async function stillCurrent(params: { store: Store; embeddable: EmbeddableEntry }): Promise<boolean> {
  const { store, embeddable: { entry, textHash } } = params;
  const current = (await store.get<MemoryEntry>(MEMORY_COLLECTION, entry.id))?.value;
  return current != null && current.removed == null && current.agentName === entry.agentName && current.scopeKey === entry.scopeKey && embeddableOf(current).textHash === textHash;
}

/**
 * Stores new vectors; resolves with one line per failure. After each write the entry is read again: one forgotten,
 * purged or changed meanwhile has its vector dropped, so a recall racing a forget never leaves an embedding behind.
 */
export async function storeVectors(params: { store: Store; embedder: Embedder; embedded: { embeddable: EmbeddableEntry; vector: number[] }[] }): Promise<string[]> {
  const { store, embedder, embedded } = params;
  const problems = await inBatches({
    items: embedded,
    run: async ({ embeddable, vector }) => {
      const { entry, textHash } = embeddable;
      const record: MemoryVectorRecord = {
        memoryId: entry.id, agentName: entry.agentName, scopeKey: entry.scopeKey, recordedAt: entry.recordedAt,
        ...(entry.runId == null ? {} : { runId: entry.runId }), ...(entry.expiresAt == null ? {} : { expiresAt: entry.expiresAt }),
        embedderId: embedder.id, dimensions: embedder.dimensions, textHash, vector,
      };
      try {
        await writeMemoryVector({ store, record });
        if (!(await stillCurrent({ store, embeddable }))) await dropMemoryVectors({ store, ids: [entry.id] });
        return undefined;
      } catch (error) {
        return `memory '${entry.id}': ${describeError(error)}`;
      }
    },
  });
  return problems.filter(problem => problem != null);
}
