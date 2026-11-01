import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { canonicalJson } from '../core/canonical-json.js';
import { describeIssues } from '../core/describe-issues.js';
import type { ProviderEvent, ProviderMessage, ProviderSettings, ProviderToolSpec } from '../providers/provider-types.js';

/** `createAigent({ learning: { responseCache } })`: replay of identical, reproducible model responses. Off by default. */
export interface ResponseCacheOptions {
  /** How long an entry is served, in ms. */
  ttlMs: number;
  /** Entries kept (least recently used dropped first). Default 500. */
  maxEntries?: number;
  /** True shares entries between instances of the same agent version; default per agent instance. */
  shared?: boolean;
}

/** Everything that decides a response: a change in any of these is a different entry. */
export interface ResponseCacheKeyParts {
  providerId: string;
  model: string;
  /** The settings as sent to the provider. */
  settings: ProviderSettings;
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  agentVersion: string;
  /** The agent instance, or `shared`. */
  scope: string;
}

/** An in-memory, least-recently-used store of complete responses (their full event arrays). */
export interface ResponseCache {
  key(parts: ResponseCacheKeyParts): string;
  /** A copy of the stored events, while the entry is fresh. */
  get(key: string): ProviderEvent[] | undefined;
  set(key: string, events: ProviderEvent[]): void;
  size(): number;
  clear(): void;
  /** Whether entries are shared between instances. */
  isShared: boolean;
}

const DEFAULT_MAX_ENTRIES = 500;
const HASH_ALGORITHM = 'sha256';

const optionsSchema = z.object({
  ttlMs: z.number().int().positive(),
  maxEntries: z.number().int().positive().optional(),
  shared: z.boolean().optional(),
}).strict();

export function parseResponseCacheOptions(options: unknown): ResponseCacheOptions {
  const parsed = optionsSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid learning.responseCache options (expected { ttlMs, maxEntries?, shared? }): ${describeIssues(parsed.error)}` });
}

/** Only reproducible sampling is replayed: temperature 0 or a fixed seed. */
export function isReproducible(settings: ProviderSettings | undefined): boolean {
  return settings?.temperature === 0 || settings?.seed != null;
}

interface Entry {
  events: ProviderEvent[];
  storedAt: number;
}

export function createResponseCache(params: { options: ResponseCacheOptions; now(): number }): ResponseCache {
  const { options: { ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, shared = false }, now } = params;
  // A Map keeps insertion order: re-inserting on use makes the first key the least recently used.
  const entries = new Map<string, Entry>();
  return {
    isShared: shared,
    key: parts => createHash(HASH_ALGORITHM).update(canonicalJson(parts)).digest('hex'),
    get: key => {
      const entry = entries.get(key);
      if (entry == null) return undefined;
      entries.delete(key);
      if (now() - entry.storedAt >= ttlMs) return undefined;
      entries.set(key, entry);
      return structuredClone(entry.events);
    },
    set: (key, events) => {
      entries.delete(key);
      entries.set(key, { events: structuredClone(events), storedAt: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
