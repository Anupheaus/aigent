import { createHash } from 'node:crypto';
import { MAX_MEMORY_TAGS } from './memory-schema.js';
import type { MemoryEntry, MemoryKind } from './memory-types.js';

/** How much each repeat of a note raises its confidence. */
const CONFIDENCE_STEP = 0.1;
/** Confidence is kept to six decimals, so repeated steps do not drift (0.8 + 0.1 is 0.9, not 0.9000000000000001). */
const CONFIDENCE_PRECISION = 1_000_000;

/** The form two notes are compared in: Unicode NFC, whitespace collapsed, trimmed, lower case. */
export function normaliseMemoryText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface MemoryIdParams {
  agentName: string;
  scopeKey: string;
  kind: MemoryKind;
  text: string;
}

/** sha-256 (hex) of the JSON array of the parts, so a separator inside one part can never shift into another. */
export function memoryId(params: MemoryIdParams): string {
  const { agentName, scopeKey, kind, text } = params;
  return createHash('sha256').update(JSON.stringify([agentName, scopeKey, kind, normaliseMemoryText(text)])).digest('hex');
}

export interface MergeMemoryParams {
  /** The stored entry with the same id. */
  current: MemoryEntry;
  /** The new entry built from the note. */
  incoming: MemoryEntry;
  now: number;
}

function raisedConfidence(left: number, right: number): number {
  return Math.round(Math.min(1, Math.max(left, right) + CONFIDENCE_STEP) * CONFIDENCE_PRECISION) / CONFIDENCE_PRECISION;
}

/**
 * A repeat of a stored note: the more confident version's text and source win (on a tie the longer text, then the
 * stored one), confidence moves 0.1 towards 1, tags are unioned (stored first, at most 5), pinned sticks, and the
 * earliest `createdAt` and the use counters are kept. A tombstone is not merged into: the note starts afresh.
 */
export function mergeMemory(params: MergeMemoryParams): MemoryEntry {
  const { current, incoming, now } = params;
  if (current.removed != null) return incoming;
  const isIncomingWinner = incoming.confidence > current.confidence
    || (incoming.confidence === current.confidence && incoming.text.length > current.text.length);
  const winner = isIncomingWinner ? incoming : current;
  return {
    ...current,
    text: winner.text,
    source: winner.source,
    // Purging the run whose text the entry holds removes it.
    ...(winner.runId == null ? {} : { runId: winner.runId }),
    // A save renews the retention window, as a rewritten record's would be.
    ...(incoming.expiresAt == null ? {} : { expiresAt: incoming.expiresAt }),
    confidence: raisedConfidence(current.confidence, incoming.confidence),
    tags: [...new Set([...current.tags, ...incoming.tags])].slice(0, MAX_MEMORY_TAGS),
    pinned: current.pinned || incoming.pinned,
    createdAt: Math.min(current.createdAt, incoming.createdAt),
    updatedAt: now,
    recordedAt: now,
  };
}
