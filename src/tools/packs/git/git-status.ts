import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { parseStatus } from './git-parse.js';
import { openRepo, runGit } from './git-run.js';
import { MAX_GIT_ITEMS, repoTitle } from './git-shared.js';
import type { GitDeps } from './git-shared.js';

export const GIT_STATUS_TOOL_NAME = 'git_status';

const statusItem = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
}).strict();

/** `git_status`: branch, upstream, ahead/behind and every changed path, from `--porcelain=v2 -z`. Never cached. */
export function createGitStatus(deps: GitDeps): Tool {
  return defineBatchTool({
    name: GIT_STATUS_TOOL_NAME,
    description: 'Show the branch, its upstream with ahead/behind counts, and every changed, staged, untracked or conflicted path (index and worktree state per path).',
    item: statusItem, maxItems: MAX_GIT_ITEMS, deterministic: false, cache: false, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: repoTitle({ verb: 'Checking git status', items }) }),
    runItem: async ({ repo }, { signal }) => {
      const opened = await openRepo({ deps, ...(repo == null ? {} : { repo }) });
      const { stdout } = await runGit({ deps, repo: opened, signal, args: ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all'] });
      return { repo: opened.path, ...parseStatus(stdout) };
    },
  });
}
