import { z } from 'zod';
import { defineTool } from '../../define-tool.js';
import type { Tool } from '../../tool-types.js';
import { toolFailure } from '../../tool-failure.js';
import { parseStatus } from './git-parse.js';
import type { StatusEntry } from './git-parse.js';
import { openRepo, runGit } from './git-run.js';
import type { GitRepo } from './git-run.js';
import type { GitDeps } from './git-shared.js';
import { deniedRepoPaths, validRepoPath } from './git-validate.js';

export const GIT_COMMIT_TOOL_NAME = 'git_commit';
const MAX_MESSAGE_CHARS = 2_000;
const MAX_PATHS = 200;
/** `git rev-parse --verify` exits 128 when there is no HEAD yet (an empty repository). */
const NO_HEAD_EXIT = 128;
/** Most refused paths named in a failure message. */
const MAX_LISTED_PATHS = 20;
/** The pathspec is read from stdin, NUL separated (literal, as every pathspec here). */
const PATHS_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

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

/** A commit about to be made: the changed paths it takes, each one allowed by the policy. */
interface PreparedCommit {
  repo: GitRepo;
  entries: StatusEntry[];
  /** The changed files the requested paths reach (a directory expanded), as git will be given them. */
  paths: string[];
}

function refused(params: { code: string; message: string; category?: 'denied'; details?: Record<string, unknown> }): never {
  throw toolFailure({ retryable: false, ...params });
}

/** The repository (checked for `write`) and the requested paths as a pathspec, each allowed for `write`. */
async function requested(params: { deps: GitDeps; args: CommitArgs }): Promise<{ repo: GitRepo; pathspec: string[] }> {
  const { deps, args: { repo, paths } } = params;
  const opened = await openRepo({ deps, permission: 'write', ...(repo == null ? {} : { repo }) });
  return { repo: opened, pathspec: await Promise.all(paths.map(path => validRepoPath({ deps, repo: opened.path, path, permission: 'write' }))) };
}

/**
 * Expands the requested paths to the changed files they reach (renames as a deletion and an addition, so each side is
 * checked) and checks every one against the policy for `write`: `.` must not sweep in `.env` or a key file. Nothing to
 * commit is a failure, not an empty commit.
 */
async function prepare(params: { deps: GitDeps; args: CommitArgs; signal: AbortSignal }): Promise<PreparedCommit> {
  const { deps, args, signal } = params;
  const { repo: opened, pathspec } = await requested({ deps, args });
  const { stdout } = await runGit({ deps, repo: opened, signal, args: ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', ...pathspec] });
  const { entries } = parseStatus(stdout);
  const paths = [...new Set(entries.map(({ path }) => path))];
  const denied = await deniedRepoPaths({ deps, repo: opened.path, paths, permission: 'write' });
  if (denied.length > 0) {
    const shown = denied.slice(0, MAX_LISTED_PATHS).join(', ');
    refused({ category: 'denied', code: 'denied_paths', message: `The paths reach ${denied.length} file(s) the policy refuses: ${shown}${denied.length > MAX_LISTED_PATHS ? ', ...' : ''}; nothing was committed`, details: { paths: denied } });
  }
  if (paths.length === 0) refused({ code: 'nothing_to_commit', message: `${args.paths.join(', ').slice(0, 200)} has no changes to commit` });
  return { repo: opened, entries, paths };
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
      const { repo, paths } = await prepare({ deps, args, signal });
      const parent = await headOf({ deps, repo, signal });
      // Exactly the checked files, from stdin: a file created since the check is not swept in, and no length limit.
      const stdin = paths.join('\0');
      await runGit({ deps, repo, signal, runHooks, stdin, args: ['add', ...PATHS_FROM_STDIN] });
      await runGit({ deps, repo, signal, runHooks, stdin, settings: identity, args: ['commit', `--message=${args.message}`, ...(runHooks ? [] : ['--no-verify']), ...PATHS_FROM_STDIN] });
      return { repo: repo.path, commit: await headOf({ deps, repo, signal }), parent, paths };
    },
    dryRun: async (args, { signal }) => {
      const { repo, entries } = await prepare({ deps, args, signal });
      const parent = await headOf({ deps, repo, signal });
      return { result: { repo: repo.path, wouldCommit: entries }, effects: [{ kind: 'git.commit', target: repo.path, summary: `commit ${entries.length} changed path(s): ${args.message.split('\n')[0] ?? ''}`, reversible: parent != null }] };
    },
    verify: async (args, { signal }) => {
      const { repo, pathspec: paths } = await requested({ deps, args });
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
