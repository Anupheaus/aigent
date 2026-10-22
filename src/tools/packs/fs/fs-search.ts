import { z } from 'zod';
import { globRegExp } from '../../../security/glob.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { ignoreMatcherFor } from './fs-list.js';
import { searchFile } from './fs-search-content.js';
import type { ContentMatch } from './fs-search-content.js';
import { createTextMatcher, SEARCH_REGEX_BUDGET_MS } from './fs-search-matcher.js';
import { filesForLayer, rankFiles } from './fs-search-rank.js';
import type { SearchLayer } from './fs-search-rank.js';
import type { TextMatcher } from './fs-search-matcher.js';
import { allowPath, baseName, FS_RESULT_HELPERS, MAX_FS_ITEMS, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { readVerified } from './fs-verify.js';
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
  layer: z.enum(['matches', 'files', 'counts']).optional().describe('Default matches; files or counts when lines are not needed'),
  order: z.enum(['path', 'relevance']).optional().describe('Default path; relevance: definitions first'),
}).strict();

type SearchItem = z.infer<typeof searchItem>;
type Found = { path: string; count: number; matches?: ContentMatch[] };

/** Skip samples a smaller layer keeps: only the ones a caller must act on (unreadable files can be retried). */
function samplesForLayer(params: { samples: Partial<Record<string, string[]>>; layer: SearchLayer }): Partial<Record<string, string[]>> {
  const { samples, layer } = params;
  if (layer === 'matches') return samples;
  return samples['unreadable'] == null ? {} : { unreadable: samples['unreadable'] };
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
  const files: WalkEntry[] = [];
  for (const entry of walked.entries) {
    // Links are never followed (they could lead out of the root) and other entries hold no text: both are counted.
    if (entry.type === 'symlink' || entry.type === 'other') { skipped.add(entry.type === 'symlink' ? 'link' : 'other', entry.relative); continue; }
    if (entry.type === 'file' && (matcher?.test(entry.relative) ?? true)) files.push(entry);
  }
  files.sort((first, second) => (first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0));
  return { files, skipped, truncated: walked.truncated };
}

/** Names matching the pattern, each counted once; undefined when the matcher stopped. */
async function matchNames(params: { files: WalkEntry[]; matcher: TextMatcher }): Promise<WalkEntry[] | 'timed-out' | 'aborted'> {
  const { files, matcher } = params;
  const outcome = await matcher({ texts: files.map(({ relative }) => baseName(relative)), keep: Number.MAX_SAFE_INTEGER });
  if (outcome.status !== 'done') return outcome.status;
  const hit = new Set(outcome.hits.map(({ text }) => text));
  return files.filter((_file, index) => hit.has(index));
}

/** `fs_search`: file names or file contents, counts first, deterministic order, every skip reported by reason. */
export function createFsSearch(deps: FsDeps): Tool {
  const { access, policy } = deps;
  async function runSearch(item: SearchItem, signal: AbortSignal): Promise<unknown> {
    const matcher = createTextMatcher({ pattern: item.pattern, regex: item.regex ?? false, caseSensitive: item.caseSensitive ?? false, wholeWord: item.wholeWord ?? false, signal });
    const allowed = await allowPath({ deps, path: item.path, permission: 'read' });
    return onDisk({
      path: item.path,
      work: async () => {
        const { files, skipped, truncated: isWalkTruncated } = await candidates({ deps, item, allowed });
        const maxMatches = item.maxMatches ?? DEFAULT_MATCHES;
        const found: Found[] = [];
        let totalMatches = 0;
        let shown = 0;
        let stoppedBy: 'timed-out' | 'aborted' | undefined;
        if (item.kind === 'name') {
          const named = await matchNames({ files, matcher });
          if (typeof named === 'string') stoppedBy = named;
          else {
            totalMatches = named.length;
            for (const { relative } of named.slice(0, maxMatches)) found.push({ path: relative, count: 1 });
            shown = found.length;
          }
        }
        for (const file of item.kind === 'content' ? files : []) {
          const searched = await searchFile({ read: path => readVerified({ deps, path }), path: file.path, size: file.size, maxBytes: policy.limits.maxReadBytes, matcher, contextLines: item.contextLines ?? 0, room: maxMatches - shown });
          if ('stopped' in searched) { stoppedBy = searched.stopped; break; }
          if ('skipped' in searched) { skipped.add(searched.skipped, file.relative); continue; }
          if (searched.count === 0) continue;
          totalMatches += searched.count;
          shown += searched.matches.length;
          found.push({ path: file.relative, count: searched.count, matches: searched.matches });
        }
        const layer = item.layer ?? 'matches';
        const isMatchesCut = layer === 'matches' && shown < totalMatches;
        const isTruncated = isWalkTruncated || isMatchesCut || stoppedBy != null;
        const hint = stoppedBy != null ? `The regular expression ran out of its ${SEARCH_REGEX_BUDGET_MS} ms budget, so later files were not searched; use a simpler pattern or a narrower path`
          : isWalkTruncated ? `The search stopped after ${policy.limits.maxFiles} entries; search a narrower path or glob`
            : `${totalMatches - shown} more matches are counted but not shown; narrow the path or glob, raise maxMatches, or ask for layer: files`;
        // The default result is unchanged; definitions are marked only when a layer or relevance order was asked for.
        const ranked = rankFiles({ files: found, pattern: item.pattern, regex: item.regex ?? false, order: item.order ?? 'path', markDefinitions: layer !== 'matches' || item.order === 'relevance' });
        const shownFiles = filesForLayer({ files: ranked, layer });
        return {
          path: allowed.path, totalMatches, filesWithMatches: found.length, ...(layer === 'matches' ? { shownMatches: shown } : {}), ...(shownFiles == null ? {} : { files: shownFiles }),
          skipped: { counts: skipped.counts, samples: samplesForLayer({ samples: skipped.samples, layer }) }, truncated: isTruncated,
          ...(isMatchesCut ? { more: { matches: totalMatches - shown, files: found.filter(({ count, matches = [] }) => matches.length < count).length } } : {}),
          ...(stoppedBy == null ? {} : { stoppedBy: stoppedBy === 'timed-out' ? 'time budget' : 'aborted' }),
          ...(isTruncated ? { hint } : {}),
        };
      },
    });
  }
  return {
    ...defineBatchTool({
      name: FS_SEARCH_TOOL_NAME,
      description: 'Search file names or contents under a directory. Returns totalMatches and matches per file (1-based line and column) in a stable order; dependency, build, VCS, lock and minified files are skipped unless includeIgnored, and every skipped entry is counted by reason (ignored, binary, tooLarge, denied, link, other). Regular expressions run under a time budget.',
      item: searchItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, contentKind: 'search-hits', fidelity: 'verbatim', acceptsAliases: true,
      describeActivity: ({ items }, outcome) => {
        const title = items.length === 1 && items[0] != null ? `Searching for '${items[0].pattern}'` : `Running ${items.length} searches`;
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: (item, { signal }) => runSearch(item, signal),
    }),
    ...FS_RESULT_HELPERS,
  };
}
