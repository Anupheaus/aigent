import { describeError } from '../core/describe-value.js';
import type { Store } from '../store/store-types.js';
import { updateRecord } from '../store/update-record.js';
import { applyRedact } from '../telemetry/redact.js';
import type { Redact } from '../telemetry/redact.js';
import { pickEvictions } from './decay.js';
import { memoryId, mergeMemory } from './dedupe.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, MemoryNote, MemorySource, ResolvedMemoryOptions, SaveMemoryResult } from './memory-types.js';

/** Where a new note starts; each repeat moves it 0.1 closer to 1. */
export const DEFAULT_MEMORY_CONFIDENCE = 0.6;

/** The notes to save and who they belong to. */
export interface SaveMemoryRequest {
  agentName: string;
  scopeKey: string;
  notes: MemoryNote[];
  source: MemorySource;
  /** Starting confidence of new entries (default 0.6; user corrections start higher). */
  confidence?: number;
}

export interface SaveMemoryParams {
  store: Store;
  redact?: Redact;
  options: ResolvedMemoryOptions;
  now: number;
  request: SaveMemoryRequest;
}

/** The entry a note becomes, before redact and before any merge with a stored one. */
function newEntry(params: { request: SaveMemoryRequest; note: MemoryNote; now: number }): MemoryEntry {
  const { request: { agentName, scopeKey, source, confidence = DEFAULT_MEMORY_CONFIDENCE }, note: { kind, text, tags = [], pinned = false }, now } = params;
  // Stored with its spacing tidied (not its case), so a repeat that differs only in spacing never counts as a longer text.
  const tidied = text.replace(/\s+/g, ' ').trim();
  return {
    id: memoryId({ agentName, scopeKey, kind, text }), agentName, scopeKey, kind, text: tidied, tags: [...new Set(tags)], source,
    confidence, pinned, uses: 0, createdAt: now, updatedAt: now, recordedAt: now,
  };
}

/** Redacts the new content; the identity fields stay the runtime's, so a hook can mask text but never move an entry. */
function redacted(params: { entry: MemoryEntry; redact?: Redact }): MemoryEntry {
  const { entry, redact } = params;
  const { id, agentName, scopeKey } = entry;
  const { value } = applyRedact({ ...(redact == null ? {} : { redact }), record: { collection: MEMORY_COLLECTION, key: id, value: entry } });
  return { ...value as MemoryEntry, id, agentName, scopeKey };
}

async function evictPastCap(params: SaveMemoryParams): Promise<{ evicted: number; problems: string[] }> {
  const { store, options: { maxEntries, halfLifeDays }, now, request: { agentName, scopeKey } } = params;
  const live = (await store.list<MemoryEntry>(MEMORY_COLLECTION))
    .map(({ value }) => value)
    .filter(entry => entry.agentName === agentName && entry.scopeKey === scopeKey && entry.removed == null);
  const { evict, pinnedOverflow } = pickEvictions({ entries: live, maxEntries, now, halfLifeDays });
  for (const { id } of evict) {
    if (store.delete != null) {
      await store.delete(MEMORY_COLLECTION, id);
      continue;
    }
    // Without delete, a tombstone keeps the key but drops the entry from recall and from the cap.
    await updateRecord<MemoryEntry>({ store, collection: MEMORY_COLLECTION, key: id, update: current => ({ ...current as MemoryEntry, removed: { at: now, reason: 'evicted' } }) });
  }
  const problems = pinnedOverflow === 0 ? [] : [`Memory of agent '${agentName}' (scope '${scopeKey}') keeps ${live.length - evict.length} entries, over its cap of ${maxEntries}, because pinned entries are never evicted`];
  return { evicted: evict.length, problems };
}

/**
 * Saves notes one by one (a failure costs only its own note): each is redacted, then written by compare-and-set,
 * merged into the stored entry with the same id. Then the agent's scope is brought back within `maxEntries`. The
 * caller runs this inside the agent's write queue, so saves of one agent never interleave.
 */
export async function saveMemory(params: SaveMemoryParams): Promise<SaveMemoryResult> {
  const { store, redact, now, request } = params;
  const problems: string[] = [];
  let saved = 0;
  for (const [position, note] of request.notes.entries()) {
    try {
      const incoming = redacted({ entry: newEntry({ request, note, now }), ...(redact == null ? {} : { redact }) });
      await updateRecord<MemoryEntry>({ store, collection: MEMORY_COLLECTION, key: incoming.id, update: current => (current == null ? incoming : mergeMemory({ current, incoming, now })) });
      saved += 1;
    } catch (error) {
      problems.push(`memory note ${position + 1} was not saved: ${describeError(error)}`);
    }
  }
  if (saved === 0) return { saved, evicted: 0, problems };
  try {
    const cap = await evictPastCap(params);
    return { saved, evicted: cap.evicted, problems: [...problems, ...cap.problems] };
  } catch (error) {
    return { saved, evicted: 0, problems: [...problems, `Memory cap of agent '${request.agentName}' was not enforced: ${describeError(error)}`] };
  }
}
