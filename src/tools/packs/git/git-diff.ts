import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { parseNumstat } from './git-parse.js';
import { openRepo, runGit } from './git-run.js';
import { FULL_HASH, MAX_GIT_ITEMS, notPinned, repoTitle } from './git-shared.js';
import type { GitDeps } from './git-shared.js';
import { validRef, validRepoPath } from './git-validate.js';

export const GIT_DIFF_TOOL_NAME = 'git_diff';
const MAX_CONTEXT_LINES = 20;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_BYTES = 100_000;
const MAX_PATHS = 50;

const diffItem = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
  from: z.string().min(1).optional().describe('Base commit, branch or tag (default: the index, or HEAD with staged)'),
  to: z.string().min(1).optional().describe('Compared commit (default: the work tree)'),
  paths: z.array(z.string().min(1)).max(MAX_PATHS).optional().describe('Only these paths (relative to the repository)'),
  staged: z.boolean().optional().describe('Staged changes against HEAD (or from)'),
  contextLines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(`Unchanged lines around changes (default ${DEFAULT_CONTEXT_LINES})`),
  maxBytes: z.number().int().min(1_000).optional().describe(`Most bytes of diff text returned (default ${DEFAULT_MAX_BYTES}, capped by the policy)`),
}).strict();

type DiffItem = z.infer<typeof diffItem>;

/** Pinned when both ends are full commit hashes and nothing depends on the work tree or index. */
const isPinned = ({ from, to, staged }: DiffItem): boolean => from != null && to != null && FULL_HASH.test(from) && FULL_HASH.test(to) && staged !== true;

/**
 * `git_diff`: a unified diff (no colour, external diff or textconv) cut at `maxBytes` with a marker, plus a numstat
 * summary. Cached (for everyone sharing the agent's namespace) only when both ends are full commit hashes.
 */
export function createGitDiff(deps: GitDeps): Tool {
  const { policy } = deps;
  return defineBatchTool({
    name: GIT_DIFF_TOOL_NAME,
    description: 'Show a unified diff (work tree, staged, or between commits) with changed file and line counts. Refs and paths are validated; output past maxBytes is cut with a marker.',
    item: diffItem, maxItems: MAX_GIT_ITEMS, deterministic: true, cache: true, contentKind: 'file-content', fidelity: 'verbatim',
    cacheKey: ({ items }) => (items.every(isPinned) ? items : notPinned()),
    describeActivity: ({ items }) => ({ title: repoTitle({ verb: 'Diffing', items }) }),
    runItem: async (item, { signal }) => {
      const { repo, from, to, paths = [], staged = false, contextLines = DEFAULT_CONTEXT_LINES, maxBytes = DEFAULT_MAX_BYTES } = item;
      const opened = await openRepo({ deps, ...(repo == null ? {} : { repo }) });
      const refs = [...(from == null ? [] : [validRef({ field: 'from', value: from })]), ...(to == null ? [] : [validRef({ field: 'to', value: to })])];
      const relative = await Promise.all(paths.map(path => validRepoPath({ deps, repo: opened.path, path })));
      const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(staged ? ['--cached'] : []), ...refs];
      const tail = ['--', ...relative];
      const [{ stdout: text }, { stdout: numstat }] = [
        await runGit({ deps, repo: opened, signal, args: [...base, `-U${contextLines}`, ...tail] }),
        await runGit({ deps, repo: opened, signal, args: [...base, '--numstat', '-z', ...tail] }),
      ];
      const limit = Math.min(maxBytes, policy.limits.maxOutputBytes);
      const bytes = Buffer.byteLength(text);
      const isCut = bytes > limit;
      const diff = isCut ? `${Buffer.from(text).subarray(0, limit).toString('utf8')}\n[diff cut at ${limit} of ${bytes} bytes; narrow it with paths]` : text;
      return { repo: opened.path, stat: parseNumstat(numstat), diff, truncated: isCut };
    },
  });
}
