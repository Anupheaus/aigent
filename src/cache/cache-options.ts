import { createAigentError } from '../core/aigent-error.js';
import type { CacheOptions } from './cache-types.js';

const DEFAULT_MAX_ENTRIES = 1_000;
/** 64 MiB. */
const DEFAULT_MAX_BYTES = 64 * 1_024 * 1_024;
/** 256 KiB. */
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1_024;

const OPTION_KEYS = ['maxEntries', 'maxBytes', 'maxEntryBytes'] as const;

/** Cache limits with every default filled in. */
export type ResolvedCacheOptions = Required<CacheOptions>;

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Validates `createAigent({ cache })` limits and fills in the defaults; throws `invalid_definition` naming each bad field. */
export function resolveCacheOptions(options: CacheOptions | undefined): ResolvedCacheOptions {
  const given = (options ?? {}) as Record<string, unknown>;
  const problems = [
    ...Object.keys(given).filter(key => !(OPTION_KEYS as readonly string[]).includes(key)).map(key => `unknown option '${key}' (allowed: ${OPTION_KEYS.join(', ')})`),
    ...OPTION_KEYS.filter(key => given[key] !== undefined && !isPositiveInteger(given[key])).map(key => `${key} must be a positive integer, got ${String(given[key])}`),
  ];
  if (problems.length > 0) {
    throw createAigentError({ code: 'invalid_definition', message: `Invalid cache options: ${problems.join('; ')}`, details: { problems: problems.length } });
  }
  const { maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = options ?? {};
  return { maxEntries, maxBytes, maxEntryBytes };
}
