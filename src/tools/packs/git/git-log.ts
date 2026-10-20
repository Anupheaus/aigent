import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { LOG_FORMAT, parseLog } from './git-parse.js';
import { openRepo, runGit } from './git-run.js';
import { FULL_HASH, MAX_GIT_ITEMS, notPinned, repoTitle } from './git-shared.js';
import type { GitDeps } from './git-shared.js';
import { validPattern, validRef, validRepoPath, validSince } from './git-validate.js';

export const GIT_LOG_TOOL_NAME = 'git_log';
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const MAX_PATHS = 50;

const logItem = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
  ref: z.string().min(1).optional().describe('Start from this commit, branch or tag (default HEAD)'),
  paths: z.array(z.string().min(1)).max(MAX_PATHS).optional().describe('Only commits touching these paths'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most commits (default ${DEFAULT_LIMIT})`),
  since: z.string().min(1).optional().describe('Only commits after this date, e.g. 2024-01-31 or "2 weeks ago"'),
  author: z.string().min(1).optional().describe('Only commits whose author contains this text (plain text, not a pattern)'),
  grep: z.string().min(1).optional().describe('Only commits whose message contains this text (plain text, not a pattern)'),
}).strict();

type LogItem = z.infer<typeof logItem>;

/** Pinned when it starts at a full hash and nothing relative to now (`since`) is involved. */
const isPinned = ({ ref, since }: LogItem): boolean => ref != null && FULL_HASH.test(ref) && since == null;

/** `git_log`: commits as `{ hash, author, date, subject }`. Cached only when it starts at a full commit hash. */
export function createGitLog(deps: GitDeps): Tool {
  return defineBatchTool({
    name: GIT_LOG_TOOL_NAME,
    description: 'List commits (hash, author, ISO date, subject), newest first, optionally from a ref, for paths, since a date, or by author or message text.',
    item: logItem, maxItems: MAX_GIT_ITEMS, deterministic: true, cache: true, contentKind: 'structured-data', fidelity: 'verbatim',
    cacheKey: ({ items }) => (items.every(isPinned) ? items : notPinned()),
    describeActivity: ({ items }) => ({ title: repoTitle({ verb: 'Reading git log', items }) }),
    runItem: async ({ repo, ref, paths = [], limit = DEFAULT_LIMIT, since, author, grep }, { signal }) => {
      const opened = await openRepo({ deps, ...(repo == null ? {} : { repo }) });
      const relative = await Promise.all(paths.map(path => validRepoPath({ deps, repo: opened.path, path })));
      // Author and message filters are literal text (--fixed-strings), so no pattern the model writes reaches a regex engine.
      const filters = [
        ...(since == null ? [] : [`--since=${validSince(since)}`]),
        ...(author == null ? [] : [`--author=${validPattern({ field: 'author', value: author })}`]),
        ...(grep == null ? [] : [`--grep=${validPattern({ field: 'grep', value: grep })}`]),
        ...(author == null && grep == null ? [] : ['--fixed-strings']),
      ];
      const start = ref == null ? [] : [validRef({ field: 'ref', value: ref })];
      const { stdout } = await runGit({ deps, repo: opened, signal, args: ['log', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, '--no-color', ...filters, ...start, '--', ...relative] });
      const commits = parseLog(stdout);
      return { repo: opened.path, commits, count: commits.length, ...(commits.length === limit ? { hint: 'There may be more: raise limit or narrow the request' } : {}) };
    },
  });
}
