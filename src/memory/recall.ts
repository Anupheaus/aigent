import { listWhere } from '../store/list-where.js';
import type { Store } from '../store/store-types.js';
import { decayFactor, entryAgeMs } from './decay.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, MemoryRetriever, RecalledMemory } from './memory-types.js';
import { relevanceScores } from './retriever.js';

/** Defaults matching `MemoryOptions`. */
const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_MIN_CONFIDENCE = 0.2;
/** How much each unit of `ln(1 + uses)` raises a memory's rank. */
const USE_BOOST = 0.05;
/** Added to confidence, so a doubtful memory is ranked down rather than out. */
const CONFIDENCE_BASE = 0.5;

export interface RecallParams {
  store: Store;
  agentName: string;
  scopeKey: string;
  /** The task text and plan labels, or the user's message. */
  query: string;
  limit: number;
  now: number;
  retriever?: MemoryRetriever;
  halfLifeDays?: number;
  /** Unpinned memories whose decayed confidence is below this are not recalled. */
  minConfidence?: number;
  onProblem?(message: string): void;
}

function isEligible(params: { entry: MemoryEntry; now: number; halfLifeDays: number; minConfidence: number }): boolean {
  const { entry, now, halfLifeDays, minConfidence } = params;
  if (entry.removed != null) return false;
  if (entry.expiresAt != null && entry.expiresAt <= now) return false;
  if (entry.pinned) return true;
  return entry.confidence * decayFactor({ ageMs: entryAgeMs({ entry, now }), halfLifeDays }) >= minConfidence;
}

/**
 * The memories of one agent and scope worth showing for `query`, best first: relevance × (0.5 + confidence) × recency
 * (halving every `halfLifeDays` since the last use or update) × (1 + 0.05·ln(1 + uses)). Unrelated memories are left
 * out (pinned ones too), as are tombstones, expired and faded ones (pinned ones never fade). Ties: later update, then id.
 * Read-only: marking the memories used is the caller's (queued) write.
 */
export async function recallMemories(params: RecallParams): Promise<RecalledMemory[]> {
  const { store, agentName, scopeKey, query, limit, now, retriever, halfLifeDays = DEFAULT_HALF_LIFE_DAYS, minConfidence = DEFAULT_MIN_CONFIDENCE, onProblem } = params;
  // Only this agent's scope is read: the collection holds every agent's and every session's memories.
  const entries = (await listWhere<MemoryEntry>({ store, collection: MEMORY_COLLECTION, where: { agentName, scopeKey } }))
    .map(({ value }) => value)
    .filter(entry => isEligible({ entry, now, halfLifeDays, minConfidence }));
  const relevance = await relevanceScores({ query, entries, ...(retriever == null ? {} : { retriever }), ...(onProblem == null ? {} : { onProblem }) });
  return entries
    .map(entry => {
      const related = relevance.get(entry.id) ?? 0;
      // Pinned or not, a memory must be related to the task: one note is never shown to every run.
      const score = related
        * (CONFIDENCE_BASE + entry.confidence)
        * decayFactor({ ageMs: entryAgeMs({ entry, now }), halfLifeDays })
        * (1 + USE_BOOST * Math.log1p(entry.uses));
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt || (left.entry.id < right.entry.id ? -1 : 1))
    .slice(0, limit)
    .map(({ entry: { id, kind, text, tags, pinned, source: { origin } }, score }) => ({ id, kind, text, tags: [...tags], pinned, origin, score }));
}
