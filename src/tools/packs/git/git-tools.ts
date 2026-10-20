import { createAigentError } from '../../../core/aigent-error.js';
import type { Tool } from '../../tool-types.js';
import { createGitBlame } from './git-blame.js';
import { createGitCommit } from './git-commit.js';
import { createGitDiff } from './git-diff.js';
import { createGitLog } from './git-log.js';
import { createGitPush } from './git-push.js';
import { resolveGitDeps } from './git-shared.js';
import type { GitToolsOptions } from './git-shared.js';
import { createGitStatus } from './git-status.js';

/**
 * The git pack: read-only `git_status`, `git_diff`, `git_log` and `git_blame` (argv built from validated fields, git
 * hardened against repository config that would run programs), plus `git_commit` and `git_push` only when enabled.
 */
export function gitTools(options: GitToolsOptions): Tool[] {
  if (typeof options?.policy?.checkCommand !== 'function') {
    throw createAigentError({ code: 'invalid_definition', message: 'gitTools needs a policy from createShellPolicy({ commands: [{ name: \'git\' }], cwdPolicy })', details: { option: 'policy' } });
  }
  const push = options.enableWrites?.push;
  if (push != null && (push.remotes.length === 0 || push.branches.length === 0)) {
    throw createAigentError({ code: 'invalid_definition', message: 'gitTools: enableWrites.push needs at least one remote and one branch', details: { option: 'enableWrites.push' } });
  }
  const deps = resolveGitDeps(options);
  return [
    createGitStatus(deps), createGitDiff(deps), createGitLog(deps), createGitBlame(deps),
    ...(deps.commit == null ? [] : [createGitCommit(deps)]),
    ...(deps.push == null ? [] : [createGitPush({ deps, allow: deps.push })]),
  ];
}
