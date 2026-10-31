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
  /** Pinned entries are never evicted by the cap and never fade out of recall. */
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

/** One note the agent attaches to a tool call through the `memory` field. */
export interface MemoryNote {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  pinned?: boolean;
}

/** `createAigent({ memory })` / `AgentDefinition.memory`: memory written only alongside tool calls. */
export interface MemoryOptions {
  /** Who shares the memories (default `agent`: every agent with the same name). */
  scope?: MemoryScope;
  /** Live entries kept per agent and scope (default 200); the lowest-scoring unpinned ones are evicted. */
  maxEntries?: number;
  /** Notes accepted on one tool call (default 3). */
  maxPerCall?: number;
  /** Days for an unused memory's weight to halve (default 30). */
  halfLifeDays?: number;
  /** Below this decayed confidence an entry is no longer recalled (default 0.2). */
  minConfidence?: number;
  /** Memories shown at the start of a run (default 6). */
  recallLimit?: number;
}

/** `MemoryOptions` with every default filled in. */
export interface ResolvedMemoryOptions {
  scope: MemoryScope;
  maxEntries: number;
  maxPerCall: number;
  halfLifeDays: number;
  minConfidence: number;
  recallLimit: number;
}

/** What one save did. */
export interface SaveMemoryResult {
  /** Notes written (new entries and merges). */
  saved: number;
  /** Entries the cap evicted to make room. */
  evicted: number;
  /** Why notes were not written, or why the cap could not be honoured; one line each. */
  problems: string[];
}
