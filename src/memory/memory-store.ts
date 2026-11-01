import { describeError } from '../core/describe-value.js';
import type { Store } from '../store/store-types.js';
import { updateRecord } from '../store/update-record.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { Redact } from '../telemetry/redact.js';
import { recallMemories } from './recall.js';
import type { RecallParams } from './recall.js';
import { saveMemory } from './save-memory.js';
import type { SaveMemoryRequest } from './save-memory.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, RecalledMemory, ResolvedMemoryOptions, SaveMemoryResult } from './memory-types.js';

export interface MemorySaveParams {
  request: SaveMemoryRequest;
  /** The saving agent's options (cap, decay). */
  options: ResolvedMemoryOptions;
}

/** Recall as the store runs it: `RecallParams` without the store and clock, which the memory store supplies. */
export type MemoryRecallParams = Omit<RecallParams, 'store' | 'now'> & {
  /** False reads without counting a use (e.g. `agent.preview`). Default true. */
  markUsed?: boolean;
};

export interface MemoryRecall {
  memories: RecalledMemory[];
  /** Settles (never rejects) once the shown memories' `uses` and `lastUsedAt` are written, behind the agent's queue. */
  used: Promise<void>;
}

export interface MemoryForgetParams {
  agentName: string;
  scopeKey: string;
  ids: string[];
}

export interface MemoryForgetResult {
  /** Ids tombstoned by this call. */
  forgotten: string[];
  /** Ids with no live entry of this agent and scope (unknown, another scope's, already forgotten or evicted). */
  notFound: string[];
  /** Lessons from a user's correction: the model may not forget what a user taught (a later correction replaces it). */
  kept: string[];
}

/** The memory domain over the runtime's store: every write is scrubbed of secrets, redacted and runs in the agent's write queue. */
export interface MemoryStore {
  /** Queued behind the agent's earlier writes; never rejects (problems are reported in the result). */
  save(params: MemorySaveParams): Promise<SaveMemoryResult>;
  /** Ranks the agent's memories for a query, then counts a use of each one shown (best effort, queued). */
  recall(params: MemoryRecallParams): Promise<MemoryRecall>;
  /** Tombstones live entries of one agent and scope: never recalled again, no longer counted against the cap. */
  forget(params: MemoryForgetParams): Promise<MemoryForgetResult>;
}

export interface CreateMemoryStoreParams {
  store: Store;
  /** The runtime's queue, keyed by agent name like every other record of the agent. */
  writeQueue: WriteQueue;
  redact?: Redact;
  /** Personal data in note text is redacted too (the runtime's pii guardrail redacts); secrets always are. */
  redactsPii?: boolean;
  /** `retention.expiresInMs`, stamped on every entry a save writes. */
  expiresInMs?: number;
  now(): number;
}

function isLive(params: { entry: MemoryEntry | undefined; agentName: string; scopeKey: string }): params is { entry: MemoryEntry; agentName: string; scopeKey: string } {
  const { entry, agentName, scopeKey } = params;
  return entry != null && entry.agentName === agentName && entry.scopeKey === scopeKey && entry.removed == null;
}

export function createMemoryStore(params: CreateMemoryStoreParams): MemoryStore {
  const { store, writeQueue, redact, redactsPii = false, expiresInMs, now } = params;

  /**
   * Changes a live entry of the agent and scope; false (writing nothing) when there is none. Only bookkeeping fields
   * change, never content, so nothing here passes through redact again.
   */
  async function updateIfLive(params: { agentName: string; scopeKey: string; id: string; change(entry: MemoryEntry): MemoryEntry }): Promise<boolean> {
    const { agentName, scopeKey, id, change } = params;
    const stored = await store.get<MemoryEntry>(MEMORY_COLLECTION, id);
    if (!isLive({ entry: stored?.value, agentName, scopeKey })) return false;
    // Re-checked inside the compare-and-set: another process may have removed it since.
    await updateRecord<MemoryEntry>({ store, collection: MEMORY_COLLECTION, key: id, update: current => (isLive({ entry: current, agentName, scopeKey }) ? change(current as MemoryEntry) : current as MemoryEntry) });
    return true;
  }

  async function markUsed(params: { agentName: string; scopeKey: string; ids: string[] }): Promise<void> {
    const { agentName, scopeKey, ids } = params;
    const at = now();
    for (const id of ids) await updateIfLive({ agentName, scopeKey, id, change: entry => ({ ...entry, uses: entry.uses + 1, lastUsedAt: at }) });
  }

  async function recall(recallParams: MemoryRecallParams): Promise<MemoryRecall> {
    const { markUsed: shouldMark = true, ...rest } = recallParams;
    const memories = await recallMemories({ ...rest, store, now: now() });
    if (!shouldMark || memories.length === 0) return { memories, used: Promise.resolve() };
    const { agentName, scopeKey, onProblem } = rest;
    const ids = memories.map(({ id }) => id);
    const used = writeQueue.enqueue(agentName, () => markUsed({ agentName, scopeKey, ids }))
      .catch((error: unknown) => { onProblem?.(`Memory uses were not recorded: ${describeError(error)}`); });
    return { memories, used };
  }

  function forget(forgetParams: MemoryForgetParams): Promise<MemoryForgetResult> {
    const { agentName, scopeKey, ids } = forgetParams;
    return writeQueue.enqueue(agentName, async () => {
      const forgotten: string[] = [];
      const notFound: string[] = [];
      const kept: string[] = [];
      for (const id of [...new Set(ids)]) {
        let isUserCorrection = false;
        const wasLive = await updateIfLive({
          agentName, scopeKey, id,
          change: entry => {
            isUserCorrection = entry.source.origin === 'user-correction';
            return isUserCorrection ? entry : { ...entry, removed: { at: now(), reason: 'forgotten' } };
          },
        });
        if (!wasLive) notFound.push(id);
        else (isUserCorrection ? kept : forgotten).push(id);
      }
      return { forgotten, notFound, kept };
    });
  }

  return {
    save: ({ request, options }) => writeQueue.enqueue(request.agentName, () => saveMemory({
      store, ...(redact == null ? {} : { redact }), redactsPii, ...(expiresInMs == null ? {} : { expiresInMs }), options, now: now(), request,
    })),
    recall,
    forget,
  };
}
