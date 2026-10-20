import { z } from 'zod';
import { defineTool } from '../../define-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { openRepo, runGit } from './git-run.js';
import type { GitDeps, GitPushOptions } from './git-shared.js';
import { validRef, validRemote } from './git-validate.js';

export const GIT_PUSH_TOOL_NAME = 'git_push';

const pushArgs = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
  remote: z.string().min(1).describe('An allowed remote name'),
  branch: z.string().min(1).describe('An allowed branch: pushed to the branch of the same name, never forced'),
}).strict();

type PushArgs = z.infer<typeof pushArgs>;

/** The push to make: an allowed remote and branch, as a refspec without `+` (so never a forced update). */
function pushTarget(params: { args: PushArgs; allow: GitPushOptions }): { remote: string; refspec: string; settings: string[] } {
  const { args: { remote, branch }, allow } = params;
  if (!allow.remotes.includes(validRemote(remote))) throw toolFailure({ category: 'denied', code: 'remote_not_allowed', message: `Remote '${remote}' is not one git_push may push to`, suggestion: `Allowed remotes: ${allow.remotes.join(', ')}`, retryable: false });
  if (!allow.branches.includes(validRef({ field: 'branch', value: branch }))) throw toolFailure({ category: 'denied', code: 'branch_not_allowed', message: `Branch '${branch}' is not one git_push may push`, suggestion: `Allowed branches: ${allow.branches.join(', ')}`, retryable: false });
  // A receive-pack command from the repository's config is cleared by the hardening; the standard one is used.
  return { remote, refspec: `refs/heads/${branch}:refs/heads/${branch}`, settings: [`remote.${remote}.receivepack=git-receive-pack`, 'push.followTags=false'] };
}

/**
 * `git_push` (only with `enableWrites.push`): pushes an allowed branch to an allowed remote, never forced (no `+`
 * refspec, no `--force`), always with approval and high risk; no undo. Its dry run is `git push --dry-run`.
 */
export function createGitPush(params: { deps: GitDeps; allow: GitPushOptions }): Tool {
  const { deps, allow } = params;
  const push = async (args: PushArgs, signal: AbortSignal, isDryRun: boolean): Promise<Record<string, unknown>> => {
    const { remote, refspec, settings } = pushTarget({ args, allow });
    const repo = await openRepo({ deps, permission: 'write', ...(args.repo == null ? {} : { repo: args.repo }) });
    const { stdout, stderr } = await runGit({ deps, repo, signal, settings, args: ['push', '--porcelain', ...(isDryRun ? ['--dry-run'] : []), '--', remote, refspec] });
    return { repo: repo.path, remote, branch: args.branch, output: `${stdout}${stderr}`.trim() };
  };
  return defineTool({
    name: GIT_PUSH_TOOL_NAME,
    description: `Push an allowed branch (${allow.branches.join(', ')}) to an allowed remote (${allow.remotes.join(', ')}). Needs approval; never forces.`,
    args: pushArgs, deterministic: false, cache: false, hasSideEffects: true, requiresApproval: { reason: 'A push publishes commits to another repository' }, risk: 'high', resume: 'ask',
    describeActivity: ({ remote, branch }, outcome) => outcome.then(({ success, reason }) => ({ title: `Pushed ${branch} to ${remote}`, ...(success ? {} : { detail: reason }) }), () => ({ title: `Pushing ${branch} to ${remote}` })),
    run: (args, { signal }) => push(args, signal, false),
    dryRun: async (args, { signal }) => {
      const result = await push(args, signal, true);
      return { result, effects: [{ kind: 'git.push', target: `${args.remote}/${args.branch}`, summary: `push ${args.branch} to ${args.remote}`, reversible: false }] };
    },
  });
}
