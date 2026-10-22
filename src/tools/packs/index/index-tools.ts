import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { FS_RESULT_HELPERS } from '../fs/fs-shared.js';
import { FILE_TAGS } from './index-types.js';
import type { IndexToolsOptions } from './index-types.js';
import { answerLayer } from './ranked-search.js';
import { filesByTags, findCards, traceRoute } from './repo-find.js';
import { repoMap } from './repo-map.js';
import { createRepoIndex } from './repo-index.js';
import type { RepoIndex } from './repo-index.js';

const MAX_ITEMS = 20;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_RESULT_TOKENS = 8_000;
const tag = z.enum(FILE_TAGS);

/** Tool fields every index tool shares: cached by arguments, valid while the index version is unchanged. */
function cached(index: RepoIndex) {
  return { deterministic: true, cache: true, validity: async () => (await index.refresh()).version, maxResultTokens: MAX_RESULT_TOKENS, contentKind: 'structured-data' as const } as const;
}

function repoMapTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_map', ...cached(index),
    description: 'Cheap overview of the repository from the index: file counts per directory and language, and tag counts. Use it instead of listing thousands of files.',
    item: z.object({ path: z.string().optional().describe('Subdirectory (default the root)'), depth: z.number().int().min(1).max(6).optional().describe('Directory levels (default 2)'), maxEntries: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Most directories shown (default 40, largest first)') }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Mapping the repository' }),
    runItem: async ({ path, depth = 2, maxEntries = 40 }) => repoMap({ snapshot: await index.refresh(), depth, maxEntries, ...(path == null ? {} : { path }) }),
  }), ...FS_RESULT_HELPERS };
}

function repoFindTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_find', ...cached(index),
    description: 'Query the file index: by file name (exact, contains or fuzzy), symbol (defines or uses), tags, language, files importing a path, files with unused exports, or a route ("GET /path": the registering file, the handler file and what the handler calls). Ranked cards with reasons.',
    item: z.object({
      name: z.string().min(1).optional(), symbol: z.string().min(1).optional(), tags: z.array(tag).optional(), language: z.string().min(1).optional(),
      route: z.string().min(1).optional().describe('METHOD /path'), importersOf: z.string().min(1).optional().describe('Repo-relative path'),
      unusedExports: z.boolean().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most cards (default ${DEFAULT_LIMIT})`),
    }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Searching the index' }),
    runItem: async ({ route, limit = DEFAULT_LIMIT, ...query }) => {
      const snapshot = await index.refresh();
      if (route != null) return { route, registrations: traceRoute({ snapshot, route }) };
      return findCards({ snapshot, query: { ...query, limit } });
    },
  }), ...FS_RESULT_HELPERS };
}

function repoTagsTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'repo_tags', ...cached(index),
    description: `List files by classification tag, counts first (tags come from code analysis: ${FILE_TAGS.join(', ')}). API route files list their live routes.`,
    item: z.object({ tags: z.array(tag).min(1), match: z.enum(['any', 'all']).optional().describe('Default any'), excludeTags: z.array(tag).optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() }).strict(),
    maxItems: MAX_ITEMS, describeActivity: () => ({ title: 'Listing tagged files' }),
    runItem: async ({ tags, match = 'any', excludeTags = [], limit = MAX_LIMIT }) => filesByTags({ snapshot: await index.refresh(), tags, match, excludeTags, limit }),
  }), ...FS_RESULT_HELPERS };
}

function searchLayersTool(index: RepoIndex): Tool {
  return { ...defineBatchTool({
    name: 'search_layers', ...cached(index),
    description: 'Search indexed file contents and stop at the cheapest layer that answers: counts, files (ranked, definitions first), snippets or full. where: code skips comments and strings; tags/excludeTags filter by file kind (e.g. exclude test). Batch related searches in one call.',
    item: z.object({
      pattern: z.string().min(1), layer: z.enum(['counts', 'files', 'snippets', 'full']), regex: z.boolean().optional(), caseSensitive: z.boolean().optional().describe('Default true'),
      wholeWord: z.boolean().optional(), where: z.enum(['code', 'any']).optional().describe('Default any'), tags: z.array(tag).optional(), excludeTags: z.array(tag).optional(),
      glob: z.string().min(1).optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional(), offset: z.number().int().min(0).optional(),
    }).strict(),
    maxItems: MAX_ITEMS, describeActivity: ({ items }) => ({ title: items.length === 1 ? `Searching for '${items[0]?.pattern ?? ''}'` : `Running ${items.length} searches` }),
    runItem: async ({ pattern, layer, regex = false, caseSensitive = true, wholeWord = false, where = 'any', tags = [], excludeTags = [], glob, limit = DEFAULT_LIMIT, offset = 0 }, { signal }) => answerLayer({
      snapshot: await index.refresh(), access: index.access, signal,
      query: { pattern, layer, regex, caseSensitive, wholeWord, where, tags, excludeTags, limit, offset, ...(glob == null ? {} : { glob }) },
    }),
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
