import { createAigentError } from '../../../core/aigent-error.js';
import type { DbPolicy } from '../../../security/db-policy-types.js';
import type { DbAccess } from './db-access.js';

/** Query results go stale; cached results are kept 30 seconds unless configured. */
export const DEFAULT_DB_CACHE_TTL_MS = 30_000;
/** The result budget of one `db_query` call, shared by its items. */
export const DEFAULT_DB_MAX_RESULT_TOKENS = 8_000;

/** `dbTools(options)`. */
export interface DbToolsOptions {
  /** The database authority every query goes through; deny by default. */
  policy: DbPolicy;
  /** How queries reach the database (`createMongoDbAccess`, `createMemoryDbAccess` or your own). */
  access: DbAccess;
  /** How long results are cached in milliseconds (default 30_000); `false` turns the cache off. */
  cacheTtlMs?: number | false;
  /** The result budget of one call (default 8_000 tokens), shared by its items. */
  maxResultTokens?: number;
}

/** What the database tools are built from. */
export interface DbDeps {
  policy: DbPolicy;
  access: DbAccess;
  cacheTtlMs: number | false;
  maxResultTokens: number;
}

function invalid(message: string, option: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `dbTools: ${message}`, details: { option } });
}

export function resolveDbDeps(options: DbToolsOptions): DbDeps {
  const { policy, access, cacheTtlMs = DEFAULT_DB_CACHE_TTL_MS, maxResultTokens = DEFAULT_DB_MAX_RESULT_TOKENS } = options ?? {};
  if (typeof policy?.rule !== 'function') invalid('needs a policy from createDbPolicy({ collections })', 'policy');
  if (typeof access?.find !== 'function' || typeof access.count !== 'function') invalid('needs an access with find and count (createMongoDbAccess or createMemoryDbAccess)', 'access');
  if (cacheTtlMs !== false && (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0)) invalid(`cacheTtlMs must be a positive integer or false, got ${String(cacheTtlMs)}`, 'cacheTtlMs');
  if (!Number.isSafeInteger(maxResultTokens) || maxResultTokens <= 0) invalid(`maxResultTokens must be a positive integer, got ${String(maxResultTokens)}`, 'maxResultTokens');
  return { policy, access, cacheTtlMs, maxResultTokens };
}
