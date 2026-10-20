import { z } from 'zod';
import { fsError } from '../../../security/fs-access.js';
import { globRegExp } from '../../../security/glob.js';
import { createIgnoreMatcher, DEFAULT_SEARCH_IGNORES, parseIgnoreFile } from '../../../security/ignore-rules.js';
import type { IgnoreMatcher } from '../../../security/ignore-rules.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { createSkipReport, walk } from './fs-walk.js';

export const FS_LIST_TOOL_NAME = 'fs_list';
const MAX_DEPTH = 8;
const MAX_LIST_LIMIT = 2_000;
const DEFAULT_LIST_LIMIT = 500;

const listItem = z.object({
  path: z.string().min(1).describe('Directory: absolute, or relative to the workspace root'),
  recursive: z.boolean().optional().describe('Also list subdirectories (default false)'),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe(`Levels below the directory to descend when recursive (default ${MAX_DEPTH})`),
  glob: z.string().min(1).optional().describe('Only entries whose path (relative to the directory) matches, e.g. **/*.ts'),
  includeHidden: z.boolean().optional().describe('Include names starting with a dot (default false)'),
  includeIgnored: z.boolean().optional().describe('Recursive only: also enter dependency, build and VCS directories (default false)'),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Most entries to return (default ${DEFAULT_LIST_LIMIT})`),
}).strict();

/** The default ignores plus the listed directory's own `.gitignore`, when there is one it may read. */
export async function ignoreMatcherFor(params: { deps: FsDeps; directory: string; caseSensitive: boolean }): Promise<IgnoreMatcher> {
  const { deps: { access, policy }, directory, caseSensitive } = params;
  const own = await policy.check({ path: `${directory}${access.platform === 'win32' ? '\\' : '/'}.gitignore`, permission: 'read', access })
    .then(async decision => (decision.allowed ? new TextDecoder().decode(await access.readFile(decision.canonicalPath)) : ''))
    .catch(() => '');
  return createIgnoreMatcher({ rules: parseIgnoreFile([...DEFAULT_SEARCH_IGNORES, own].join('\n')), caseSensitive });
}

/** `fs_list`: directory entries, sorted, with every skip (denied, hidden, ignored) counted. */
export function createFsList(deps: FsDeps): Tool {
  const { access, policy } = deps;
  return {
    ...defineBatchTool({
      name: FS_LIST_TOOL_NAME,
      description: 'List directory entries (path relative to the directory, type, size, modification time), sorted. Recursive listings leave out dependency, build and VCS directories unless includeIgnored; every skipped entry is counted by reason.',
      item: listItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, contentKind: 'structured-data', acceptsAliases: true,
      describeActivity: ({ items }) => ({ title: countTitle({ verb: 'Listing', noun: 'directories', paths: items.map(({ path }) => path) }) }),
      runItem: async ({ path, recursive = false, depth = MAX_DEPTH, glob, includeHidden = false, includeIgnored = false, limit = DEFAULT_LIST_LIMIT }) => {
        const allowed = await allowPath({ deps, path, permission: 'read' });
        return onDisk({
          path,
          work: async () => {
            if ((await access.stat(allowed.path)).type !== 'directory') throw fsError({ code: 'ENOTDIR', path: allowed.path, message: 'is not a directory' });
            const caseSensitive = policy.caseSensitive(access);
            const ignore = recursive && !includeIgnored ? await ignoreMatcherFor({ deps, directory: allowed.path, caseSensitive }) : undefined;
            const skipped = createSkipReport();
            const walked = await walk({ deps, start: allowed.path, root: allowed.root, maxDepth: recursive ? depth : 0, includeHidden, ...(ignore == null ? {} : { ignore }), maxEntries: policy.limits.maxFiles, skipped });
            const matcher = glob == null ? undefined : globRegExp({ pattern: glob, caseSensitive });
            const matching = walked.entries.filter(({ relative }) => matcher?.test(relative) ?? true).sort((first, second) => (first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0));
            const shown = matching.slice(0, limit);
            const count = (type: string): number => matching.filter(entry => entry.type === type).length;
            return {
              path: allowed.path,
              entries: shown.map(({ relative, type, size, mtimeMs }) => ({ path: relative, type, size, mtimeMs })),
              counts: { files: count('file'), directories: count('directory'), symlinks: count('symlink'), other: count('other') },
              skipped: { counts: skipped.counts, samples: skipped.samples },
              truncated: walked.truncated || matching.length > shown.length,
            };
          },
        });
      },
    }),
    ...FS_RESULT_HELPERS,
  };
}
