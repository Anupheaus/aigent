import type { Tool } from '../../tool-types.js';
import { createDbQuery } from './db-query.js';
import { resolveDbDeps } from './db-shared.js';
import type { DbToolsOptions } from './db-shared.js';

/**
 * The database pack: `db_query`, read-only by construction. Every query goes through `options.policy` (deny by default:
 * listed collections, allowed fields and operators, limits and time caps) before `options.access` sees it.
 */
export function dbTools(options: DbToolsOptions): Tool[] {
  return [createDbQuery(resolveDbDeps(options))];
}
