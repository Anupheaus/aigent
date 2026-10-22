import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { FS_RESULT_HELPERS } from '../fs/fs-shared.js';
import { FILE_TAGS } from './index-types.js';
import type { FileTag, IndexSnapshot, IndexToolsOptions } from './index-types.js';
import { answerLayer } from './ranked-search.js';
import { filesByTags, findCards, traceRoute } from './repo-find.js';
import { repoMap } from './repo-map.js';
import { createRepoIndex } from './repo-index.js';
import type { RepoIndex } from './repo-index.js';

const MAX_ITEMS = 20;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_RESULT_TOKENS = 8_000;
/** Tags are plain strings in the schemas (the list is long and every request carries the schemas); checked here. */
const tagList = z.array(z.string().min(1));
const limit = z.number().int().min(1).max(MAX_LIMIT);

function checkTags(tags: string[] | undefined): FileTag[] {
  const unknown = (tags ?? []).filter(tag => !(FILE_TAGS as readonly string[]).includes(tag));
  if (unknown.length > 0) throw toolFailure({ code: 'unknown_tag', message: `Unknown tag(s): ${unknown.join(', ')}`, suggestion: `Use: ${FILE_TAGS.join(', ')}`, retryable: false, details: { unknown } });
  return (tags ?? []) as FileTag[];
}

/** The snapshot of one call: its validity token and every item's answer come from the same walk. */
const snapshotOf = (params: { index: RepoIndex; context: ToolContext }): Promise<IndexSnapshot> => params.index.refreshFor(`${params.context.runId}:${params.context.callId}`);

/**
 * An item's result with what the index (and, for a search, the query itself) left out: skip counts by reason and the
 * files that could not be read, so an answer that may be incomplete says so. Nothing is added when nothing was skipped.
 */
function withSkips(params: { snapshot: IndexSnapshot; result: object; unreadable?: string[]; tooLarge?: number }): Record<string, unknown> {
  const { snapshot, result, unreadable: queryUnreadable = [], tooLarge = 0 } = params;
  const skipped: Record<string, number> = { ...snapshot.skipped };
  if (queryUnreadable.length > 0) skipped['unreadable'] = (skipped['unreadable'] ?? 0) + queryUnreadable.length;
  if (tooLarge > 0) skipped['tooLarge'] = (skipped['tooLarge'] ?? 0) + tooLarge;
  const unreadable = [...new Set([...snapshot.unreadable, ...queryUnreadable])].sort();
  return { ...result, ...(Object.keys(skipped).length === 0 ? {} : { skipped }), ...(unreadable.length === 0 ? {} : { unreadable }) };
}

/** Tool fields every index tool shares: cached by arguments, valid while the index version is unchanged. */
function cached(index: RepoIndex) {
  return { deterministic: true, cache: true, validity: async (_args: unknown, context: ToolContext) => (await snapshotOf({ index, context })).version, maxResultTokens: MAX_RESULT_TOKENS, contentKind: 'structured-data' as const } as const;
}

function repoMapTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_map', ...cached(index),
    description: 'Overview from the index: files per directory and language, tag counts (instead of listing files).',
    item: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(6).optional(), maxEntries: limit.optional() }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Mapping the repository' }),
    runItem: async ({ path, depth = 2, maxEntries = 40 }, context) => {
      const snapshot = await snapshotOf({ index, context });
      return withSkips({ snapshot, result: repoMap({ snapshot, depth, maxEntries, ...(path == null ? {} : { path }) }) });
    },
  }), ...FS_RESULT_HELPERS };
}

function repoFindTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_find', ...cached(index),
    description: 'Query the file index (fields combine): name, symbol (defines or uses), tags, language, importersOf (a path), unusedExports; or route ("GET /path": registering file, handler file, what it calls).',
    item: z.object({ name: z.string().min(1).optional(), symbol: z.string().min(1).optional(), tags: tagList.optional(), language: z.string().min(1).optional(), route: z.string().min(1).optional(), importersOf: z.string().min(1).optional(), unusedExports: z.boolean().optional(), limit: limit.optional() }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Searching the index' }),
    runItem: async ({ route, limit: most = DEFAULT_LIMIT, tags, ...query }, context) => {
      const snapshot = await snapshotOf({ index, context });
      if (route != null) return withSkips({ snapshot, result: { route, registrations: traceRoute({ snapshot, route }) } });
      return withSkips({ snapshot, result: findCards({ snapshot, query: { ...query, ...(tags == null ? {} : { tags: checkTags(tags) }), limit: most } }) });
    },
  }), ...FS_RESULT_HELPERS };
}

function repoTagsTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_tags', ...cached(index),
    description: `Files by tag, counts first; route files list live routes. Tags: ${FILE_TAGS.join(', ')}.`,
    item: z.object({ tags: tagList.min(1), match: z.enum(['any', 'all']).optional(), excludeTags: tagList.optional(), limit: limit.optional() }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Listing tagged files' }),
    runItem: async ({ tags, match = 'any', excludeTags, limit: most = MAX_LIMIT }, context) => {
      const snapshot = await snapshotOf({ index, context });
      return withSkips({ snapshot, result: filesByTags({ snapshot, tags: checkTags(tags), match, excludeTags: checkTags(excludeTags), limit: most }) });
    },
  }), ...FS_RESULT_HELPERS };
}

function searchLayersTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'search_layers', ...cached(index),
    description: 'Search indexed files, answering at the cheapest layer that suffices: counts, files (definitions first), snippets or full. where: code skips comments and strings; tags/excludeTags filter by kind (repo_tags lists them).',
    item: z.object({
      pattern: z.string().min(1), layer: z.enum(['counts', 'files', 'snippets', 'full']), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(),
      where: z.enum(['code', 'any']).optional(), tags: tagList.optional(), excludeTags: tagList.optional(), glob: z.string().min(1).optional(), limit: limit.optional(), offset: z.number().int().min(0).optional(),
    }).strict(),
    maxItems: MAX_ITEMS, describeActivity: ({ items }) => ({ title: items.length === 1 ? `Searching for '${items[0]?.pattern ?? ''}'` : `Running ${items.length} searches` }),
    runItem: async ({ pattern, layer, regex = false, caseSensitive = true, wholeWord = false, where = 'any', tags, excludeTags, glob, limit: most = DEFAULT_LIMIT, offset = 0 }, context) => {
      const snapshot = await snapshotOf({ index, context });
      const { answer, unreadable, tooLarge } = await answerLayer({
        snapshot, deps: index.deps, signal: context.signal,
        query: { pattern, layer, regex, caseSensitive, wholeWord, where, tags: checkTags(tags), excludeTags: checkTags(excludeTags), limit: most, offset, ...(glob == null ? {} : { glob }) },
      });
      return withSkips({ snapshot, result: answer, unreadable, tooLarge });
    },
  }), ...FS_RESULT_HELPERS };
}

/**
 * The repository index pack: `repo_map`, `repo_find`, `repo_tags` and `search_layers` over an incremental index of
 * the policy's root (cards rebuilt only for changed files; every read through the policy's walk). Results are cached
 * by their arguments and served only while the index version is unchanged.
 */
export function indexTools(options: IndexToolsOptions): Tool[] {
  const index = createRepoIndex(options);
  return [repoMapTool(index), repoFindTool(index), repoTagsTool(index), searchLayersTool(index)];
}
