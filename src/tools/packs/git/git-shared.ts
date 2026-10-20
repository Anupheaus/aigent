import type { ProcessRunner } from '../../../security/process-runner.js';
import { createNodeProcessRunner } from '../../../security/process-runner-node.js';
import type { ShellPolicy } from '../../../security/shell-policy-types.js';

/** `git_commit` options: hooks stay disabled unless `runHooks`. */
export interface GitCommitOptions {
  runHooks?: boolean;
}

/** `git_push` allowlists: only these remotes and branches, never forced. */
export interface GitPushOptions {
  remotes: string[];
  branches: string[];
}

/** The gated write tools; none is registered unless enabled here. */
export interface GitWriteOptions {
  commit?: boolean | GitCommitOptions;
  push?: GitPushOptions;
}

/** `gitTools(options)`. */
export interface GitToolsOptions {
  /**
   * Must allow the command `git` (without `argRules`: the git tools build and check their own argv). Its `cwdPolicy`
   * decides which repositories may be used: a repository's root must pass its read check (write for `git_commit`).
   */
  policy: ShellPolicy;
  /** Default: real processes. */
  runner?: ProcessRunner;
  enableWrites?: GitWriteOptions;
  /** Author and committer of `git_commit` (otherwise the repository's own `user.name`/`user.email`). */
  identity?: { name: string; email: string };
}

export interface GitDeps {
  policy: ShellPolicy;
  runner: ProcessRunner;
  commit?: { runHooks: boolean };
  push?: GitPushOptions;
  identity?: { name: string; email: string };
}

export function resolveGitDeps(options: GitToolsOptions): GitDeps {
  const { policy, runner = createNodeProcessRunner(), enableWrites = {}, identity } = options;
  const { commit, push } = enableWrites;
  return {
    policy, runner,
    ...(commit == null || commit === false ? {} : { commit: { runHooks: commit === true ? false : commit.runHooks === true } }),
    ...(push == null ? {} : { push }),
    ...(identity == null ? {} : { identity }),
  };
}

/** Upper bound on items in one read call. */
export const MAX_GIT_ITEMS = 10;

/** A full commit hash (SHA-1 or SHA-256): a request pinned to these always gives the same result. */
export const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Thrown by `cacheKey` for a request that is not pinned to commits: the cache then neither serves nor stores it. */
export function notPinned(): never {
  throw new Error('not pinned to full commit hashes: not cached');
}

/** "Reading git log in repo" style titles. */
export function repoTitle(params: { verb: string; items: { repo?: string }[] }): string {
  const { verb, items } = params;
  const [first] = items;
  return items.length === 1 ? `${verb}${first?.repo == null ? '' : ` in ${first.repo}`}` : `${verb} (${items.length} requests)`;
}
