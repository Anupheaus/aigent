import { z } from 'zod';
import { globRegExp } from '../../../security/glob.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { compileGuardedRegex, literalPattern } from '../regex-guard.js';
import { ignoreMatcherFor } from './fs-list.js';
import { searchFile } from './fs-search-content.js';
import type { ContentMatch } from './fs-search-content.js';
import { allowPath, baseName, FS_RESULT_HELPERS, MAX_FS_ITEMS, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { createSkipReport, walk } from './fs-walk.js';
import type { WalkEntry } from './fs-walk.js';

export const FS_SEARCH_TOOL_NAME = 'fs_search';
const MAX_CONTEXT_LINES = 5;
const MAX_MATCHES = 500;
const DEFAULT_MATCHES = 100;
const MAX_SEARCH_DEPTH = 64;

const searchItem = z.object({
  path: z.string().min(1).describe('Directory (or file) to search: absolute, or relative to the workspace root'),
  pattern: z.string().min(1).describe('Text to find (a regular expression with regex: true)'),
  kind: z.enum(['name', 'content']).describe('name: match file names; content: match lines inside files'),
  regex: z.boolean().optional().describe('Treat pattern as a regular expression (default false: plain text)'),
  caseSensitive: z.boolean().optional().describe('Default false'),
  wholeWord: z.boolean().optional().describe('Only whole-word matches (default false)'),
  glob: z.string().min(1).optional().describe('Only files whose path (relative to path) matches, e.g. **/*.ts'),
  contextLines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe('Lines shown before and after each match (default 0)'),
  maxMatches: z.number().int().min(1).max(MAX_MATCHES).optional().describe(`Most matches returned in full (default ${DEFAULT_MATCHES}); all are counted`),
  includeIgnored: z.boolean().optional().describe('Also search dependency, build, VCS, lock and minified files (default false)'),
}).strict();

type SearchItem = z.infer<typeof searchItem>;

function regexFor(item: SearchItem): RegExp {
  const { pattern, regex = false, caseSensitive = false, wholeWord = false } = item;
  const source = regex ? pattern : literalPattern(pattern);
  // The guard sees the model's pattern itself, so a wrapper never hides nested repetition from it.
  const guarded = compileGuardedRegex({ pattern: source, flags: caseSensitive ? 'g' : 'gi' });
  return wholeWord ? new RegExp(`\\b(?:${guarded.source})\\b`, guarded.flags) : guarded;
}

/** The files to search under the allowed path, and the walk's skips (the path itself when it is a file). */
async function candidates(params: { deps: FsDeps; item: SearchItem; allowed: { path: string; root: string } }) {
  const { deps, item, allowed } = params;
  const { access, policy } = deps;
  const skipped = createSkipReport();
  const stat = await access.stat(allowed.path);
  if (stat.type !== 'directory') return { files: [{ path: allowed.path, relative: baseName(allowed.path), type: stat.type, size: stat.size, mtimeMs: stat.mtimeMs }], skipped, truncated: false };
  const caseSensitive = policy.caseSensitive(access);
  const ignore = item.includeIgnored === true ? undefined : await ignoreMatcherFor({ deps, directory: allowed.path, caseSensitive });
  const walked = await walk({ deps, start: allowed.path, root: allowed.root, maxDepth: MAX_SEARCH_DEPTH, includeHidden: true, ...(ignore == null ? {} : { ignore }), maxEntries: policy.limits.maxFiles, skipped });
  const matcher = item.glob == null ? undefined : globRegExp({ pattern: item.glob, caseSensitive });
  const files = walked.entries.filter(({ type, relative }) => type === 'file' && (matcher?.test(relative) ?? true)).sort((first, second) => (first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0));
  return { files, skipped, truncated: walked.truncated };
}

/** `fs_search`: file names or file contents, counts first, deterministic order, every skip reported by reason. */
export function createFsSearch(deps: FsDeps): Tool {
  const { access, policy } = deps;
  async function runSearch(item: SearchItem): Promise<unknown> {
    const regex = regexFor(item);
    const allowed = await allowPath({ deps, path: item.path, permission: 'read' });
    return onDisk({
      path: item.path,
      work: async () => {
        const { files, skipped, truncated: isWalkTruncated } = await candidates({ deps, item, allowed });
        const maxMatches = item.maxMatches ?? DEFAULT_MATCHES;
        const found: { path: string; count: number; matches?: ContentMatch[] }[] = [];
        let totalMatches = 0;
        let shown = 0;
        for (const file of files as WalkEntry[]) {
          if (item.kind === 'name') {
            if (!regexFor(item).test(baseName(file.relative))) continue;
            totalMatches += 1;
            if (shown < maxMatches) { found.push({ path: file.relative, count: 1 }); shown += 1; }
            continue;
          }
          const searched = await searchFile({ access, path: file.path, size: file.size, maxBytes: policy.limits.maxReadBytes, regex, contextLines: item.contextLines ?? 0, room: maxMatches - shown });
          if ('skipped' in searched) { skipped.add(searched.skipped, file.relative); continue; }
          if (searched.count === 0) continue;
          totalMatches += searched.count;
          shown += searched.matches.length;
          found.push({ path: file.relative, count: searched.count, matches: searched.matches });
        }
        const isTruncated = isWalkTruncated || shown < totalMatches;
        return {
          path: allowed.path, totalMatches, filesWithMatches: found.length, shownMatches: shown, files: found,
          skipped: { counts: skipped.counts, samples: skipped.samples }, truncated: isTruncated,
          ...(isTruncated ? { hint: isWalkTruncated ? `The search stopped after ${policy.limits.maxFiles} entries; search a narrower path or glob` : `${totalMatches - shown} more matches are counted but not shown; narrow the path or glob, or raise maxMatches` } : {}),
        };
      },
    });
  }
  return {
    ...defineBatchTool({
      name: FS_SEARCH_TOOL_NAME,
      description: 'Search file names or contents under a directory. Returns totalMatches and matches per file (1-based line and column) in a stable order; dependency, build, VCS, lock and minified files are skipped unless includeIgnored, and every skipped file is counted by reason (ignored, binary, tooLarge, denied).',
      item: searchItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, contentKind: 'search-hits', fidelity: 'verbatim', acceptsAliases: true,
      describeActivity: ({ items }, outcome) => {
        const title = items.length === 1 && items[0] != null ? `Searching for '${items[0].pattern}'` : `Running ${items.length} searches`;
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: runSearch,
    }),
    ...FS_RESULT_HELPERS,
  };
}
