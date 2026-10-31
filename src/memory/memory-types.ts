/** The store collection that holds every memory entry, keyed by entry id. */
export const MEMORY_COLLECTION = 'memory';

/** What a memory is about. */
export const MEMORY_KINDS = ['fact', 'preference', 'lesson', 'procedure'] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];

/** Who memories are shared with: every agent of the same name, one chat session, or one consumer-named interface. */
export const MEMORY_SCOPES = ['agent', 'session', 'interface'] as const;

export type MemoryScope = typeof MEMORY_SCOPES[number];

/** How an entry came to be written. */
export type MemoryOrigin = 'tool-call' | 'user-correction' | 'manual';

/** Where an entry (or the version of it that won a merge) came from. */
export interface MemorySource {
  runId: string;
  /** The tool call that carried it (`origin: 'tool-call'`). */
  callId?: string;
  origin: MemoryOrigin;
}

/** Why an entry no longer counts: forgotten by `memory_forget`, or evicted by the cap (stores without `delete`). */
export interface MemoryRemoval {
  /** Epoch ms. */
  at: number;
  reason: 'forgotten' | 'evicted';
}

/** One stored memory (collection `memory`, keyed by `id`). */
export interface MemoryEntry {
  /** sha-256 of agent name, scope key, kind and normalised text: the same note always lands on the same entry. */
  id: string;
  agentName: string;
  /** `agent`, `session:<id>` or `interface:<key>`. */
  scopeKey: string;
  kind: MemoryKind;
  /** 1 to 300 characters, as `redact` left it. */
  text: string;
  /** Up to 5, each up to 24 characters. */
  tags: string[];
  source: MemorySource;
  /** 0 to 1; a note starts at 0.6 and each repeat moves it 0.1 closer to 1. */
  confidence: number;
  /**
   * Set only by the application, never by the model's notes. A pinned entry never fades (decay and `minConfidence` do
   * not hide it) and the cap evicts it only after every unpinned one; it is still recalled only when related.
   */
  pinned: boolean;
  /** How often recall has shown it. */
  uses: number;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
  /** Epoch ms of the last recall that showed it. */
  lastUsedAt?: number;
  /** Epoch ms after which recall ignores it. */
  expiresAt?: number;
  /** Equal to `updatedAt`: lets `ai.purge({ before })` reach memory like any other record. */
  recordedAt: number;
  /** Set on a tombstone: the entry is never recalled and does not count against the cap. */
  removed?: MemoryRemoval;
}

/** One note to save: from the `memory` field of a tool call, or written by the runtime (user corrections). */
export interface MemoryNote {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  /** Only the application pins; notes parsed from the model's `memory` field never carry it. */
  pinned?: boolean;
}

/** `createAigent({ memory })` / `AgentDefinition.memory`: memory written only alongside tool calls. */
export interface MemoryOptions {
  /** Who shares the memories (default `agent`: every agent with the same name). */
  scope?: MemoryScope;
  /** Live entries kept per agent and scope (default 200), pinned ones included; the lowest-scoring unpinned ones are evicted first. */
  maxEntries?: number;
  /** Notes accepted on one tool call (default 3). */
  maxPerCall?: number;
  /** Days for an unused memory's weight to halve (default 30). */
  halfLifeDays?: number;
  /** Below this decayed confidence an entry is no longer recalled (default 0.2). */
  minConfidence?: number;
  /** Memories shown at the start of a run (default 6). */
  recallLimit?: number;
  /** Replaces BM25 relevance in recall (e.g. an embedding retriever); a failing retriever falls back to BM25. */
  retriever?: MemoryRetriever;
}

/** `MemoryOptions` with every default filled in (the retriever stays out: it is code, not configuration). */
export interface ResolvedMemoryOptions {
  scope: MemoryScope;
  maxEntries: number;
  maxPerCall: number;
  halfLifeDays: number;
  minConfidence: number;
  recallLimit: number;
}

/** Pluggable relevance for recall (e.g. embeddings); without one, recall ranks by BM25 over text and tags. */
export interface MemoryRetriever {
  /** A relevance score (higher is better, 0 for none) for the entries it can judge; missing entries score 0. */
  rank(query: string, entries: MemoryEntry[]): Promise<MemoryRank[]>;
}

/** One entry's relevance to a query. */
export interface MemoryRank {
  id: string;
  score: number;
}

/** A memory chosen by recall, best first. */
export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  /** As stored: untrusted data, rendered defused. */
  text: string;
  tags: string[];
  pinned: boolean;
  /** relevance × (0.5 + confidence) × recency × use boost. */
  score: number;
}

/** What one save did. */
export interface SaveMemoryResult {
  /** Notes written (new entries and merges). */
  saved: number;
  /** Entries the cap evicted to make room. */
  evicted: number;
  /** Why notes were not written; one line each. */
  problems: string[];
}
