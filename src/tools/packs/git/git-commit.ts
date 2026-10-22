import { z } from 'zod';
import { defineTool } from '../../define-tool.js';
import type { Tool } from '../../tool-types.js';
import { parseStatus } from './git-parse.js';
import { openRepo, runGit } from './git-run.js';
import type { GitRepo } from './git-run.js';
import type { GitDeps } from './git-shared.js';
import { validRepoPath } from './git-validate.js';

export const GIT_COMMIT_TOOL_NAME = 'git_commit';
const MAX_MESSAGE_CHARS = 2_000;
const MAX_PATHS = 200;
/** `git rev-parse --verify` exits 128 when there is no HEAD yet (an empty repository). */
const NO_HEAD_EXIT = 128;

const commitArgs = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
  message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The commit message'),
  paths: z.array(z.string().min(1)).min(1).max(MAX_PATHS).describe('Exactly the paths to commit (their current content); nothing else is included'),
  allowEmpty: z.literal(false).optional().describe('Empty commits are never made'),
}).strict();

type CommitArgs = z.infer<typeof commitArgs>;

async function headOf(params: { deps: GitDeps; repo: GitRepo; signal: AbortSignal }): Promise<string | null> {
  const { stdout, exitCode } = await runGit({ ...params, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], okExitCodes: [0, 1, NO_HEAD_EXIT] });
  return exitCode === 0 ? stdout.trim() : null;
}

async function prepare(params: { deps: GitDeps; args: CommitArgs }): Promise<{ repo: GitRepo; paths: string[] }> {
  const { deps, args: { repo, paths } } = params;
  const opened = await openRepo({ deps, permission: 'write', ...(repo == null ? {} : { repo }) });
  return { repo: opened, paths: await Promise.all(paths.map(path => validRepoPath({ deps, repo: opened.path, path }))) };
}

/**
 * `git_commit` (only with `enableWrites.commit`): stages and commits exactly the given paths. Always needs approval,
 * runs no hooks unless `runHooks`, can be dry-run (what would be committed) and undone (a soft reset to the previous
 * HEAD, only while HEAD is still this commit); a resumed run checks HEAD's message and those paths.
 */
export function createGitCommit(deps: GitDeps): Tool {
  const runHooks = deps.commit?.runHooks === true;
  const identity = deps.identity == null ? [] : [`user.name=${deps.identity.name}`, `user.email=${deps.identity.email}`];
  return defineTool({
    name: GIT_COMMIT_TOOL_NAME,
    description: 'Commit exactly the listed paths with a message (needs approval). Never commits anything else, never amends, never makes empty commits.',
    args: commitArgs, deterministic: false, cache: false, hasSideEffects: true, requiresApproval: { reason: 'A commit changes the repository history' }, risk: 'medium', resume: 'verify',
    describeActivity: ({ paths }, outcome) => outcome.then(({ success, reason }) => ({ title: `Committed ${paths.length} path${paths.length === 1 ? '' : 's'}`, ...(success ? {} : { detail: reason }) }), () => ({ title: 'Committing' })),
    run: async (args, { signal }) => {
      const { repo, paths } = await prepare({ deps, args });
      const parent = await headOf({ deps, repo, signal });
      await runGit({ deps, repo, signal, runHooks, args: ['add', '--', ...paths] });
      await runGit({ deps, repo, signal, runHooks, settings: identity, args: ['commit', `--message=${args.message}`, ...(runHooks ? [] : ['--no-verify']), '--', ...paths] });
      return { repo: repo.path, commit: await headOf({ deps, repo, signal }), parent, paths };
    },
    dryRun: async (args, { signal }) => {
      const { repo, paths } = await prepare({ deps, args });
      const { stdout } = await runGit({ deps, repo, signal, args: ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', ...paths] });
      const { entries } = parseStatus(stdout);
      const parent = await headOf({ deps, repo, signal });
      return { result: { repo: repo.path, wouldCommit: entries }, effects: [{ kind: 'git.commit', target: repo.path, summary: `commit ${entries.length} changed path(s): ${args.message.split('\n')[0] ?? ''}`, reversible: parent != null }] };
    },
    verify: async (args, { signal }) => {
      const { repo, paths } = await prepare({ deps, args });
      const { stdout } = await runGit({ deps, repo, signal, args: ['log', '-1', '--format=%B'], okExitCodes: [0, NO_HEAD_EXIT] });
      const isSame = await runGit({ deps, repo, signal, args: ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD', '--', ...paths], okExitCodes: [0, 1, NO_HEAD_EXIT] });
      return { done: stdout.trim() === args.message.trim() && isSame.exitCode === 0 };
    },
    undo: async (_args, result) => {
      const { repo, commit, parent } = result as { repo: string; commit: string | null; parent: string | null };
      return commit == null || parent == null ? undefined : { repo, commit, parent };
    },
    applyUndo: async (descriptor, { signal }) => {
      const { repo, commit, parent } = descriptor as { repo: string; commit: string; parent: string };
      const opened = await openRepo({ deps, repo, permission: 'write' });
      const head = await headOf({ deps, repo: opened, signal });
      if (head !== commit) return { ok: false, message: `HEAD is now ${head ?? 'unborn'}, not the commit ${commit}, so it was left alone` };
      await runGit({ deps, repo: opened, signal, args: ['reset', '--soft', parent] });
      return { ok: true };
    },
  });
}
