import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { Redact } from '../telemetry/redact.js';
import { saveMemory } from './save-memory.js';
import type { SaveMemoryRequest } from './save-memory.js';
import type { ResolvedMemoryOptions, SaveMemoryResult } from './memory-types.js';

export interface MemorySaveParams {
  request: SaveMemoryRequest;
  /** The saving agent's options (cap, decay). */
  options: ResolvedMemoryOptions;
}

/** The memory domain over the runtime's store: every write is redacted and runs in the agent's write queue. */
export interface MemoryStore {
  /** Queued behind the agent's earlier writes; never rejects (problems are reported in the result). */
  save(params: MemorySaveParams): Promise<SaveMemoryResult>;
}

export interface CreateMemoryStoreParams {
  store: Store;
  /** The runtime's queue, keyed by agent name like every other record of the agent. */
  writeQueue: WriteQueue;
  redact?: Redact;
  now(): number;
}

export function createMemoryStore(params: CreateMemoryStoreParams): MemoryStore {
  const { store, writeQueue, redact, now } = params;
  return {
    save: ({ request, options }) => writeQueue.enqueue(request.agentName, () => saveMemory({ store, ...(redact == null ? {} : { redact }), options, now: now(), request })),
  };
}
