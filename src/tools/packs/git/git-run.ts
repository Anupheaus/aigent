import type { FsPermission } from '../../../security/fs-policy-types.js';
import type { ProcessResult } from '../../../security/process-runner.js';
import { separatorOf } from '../../../security/path-flavour.js';
import { toolFailure } from '../../tool-failure.js';
import { executingKeys, gitSandbox, hardenedSettings, unoverridableKeys } from './git-config-guard.js';
import type { GitDeps } from './git-shared.js';

/** A repository the policy allows: its canonical root and the git executable. */
export interface GitRepo {
  path: string;
  file: string;
}

/** `runGit`. */
export interface GitCall {
  deps: GitDeps;
  repo: GitRepo;
  /** The subcommand and its arguments, built by the tool from validated fields. */
  args: string[];
  signal: AbortSignal;
  /** Hooks run only for a commit configured with `runHooks`. */
  runHooks?: boolean;
  /** Further `-c` settings (after the hardening, so they win). */
  settings?: string[];
  /** Exit codes that are not failures (default 0 only). */
  okExitCodes?: number[];
  /** Written to git's standard input (for `--pathspec-from-file=-`). */
  stdin?: string;
}

function failed(params: { code: string; message: string; category?: 'denied' | 'thrown'; details?: Record<string, unknown> }): never {
  throw toolFailure({ retryable: false, ...params });
}

/**
 * Checks a repository through the policy: `git` must be allowed, the root must pass the cwd policy (and `write` for
 * writes), and it must be the top of a work tree with a real `.git` directory (git never searches upwards here).
 */
export async function openRepo(params: { deps: GitDeps; repo?: string; permission?: FsPermission }): Promise<GitRepo> {
  const { deps: { policy }, repo, permission = 'read' } = params;
  const decision = await policy.checkCommand({ command: 'git', args: [], ...(repo == null ? {} : { cwd: repo }) });
  if (!decision.allowed) failed({ category: 'denied', code: decision.code, message: decision.message });
  const { cwdPolicy, access } = policy;
  if (permission !== 'read') {
    const write = await cwdPolicy.check({ path: decision.cwd, permission, access });
    if (!write.allowed) failed({ category: 'denied', code: write.code, message: write.message });
  }
  const gitDir = `${decision.cwd}${separatorOf(access.platform)}.git`;
  const type = await access.lstat(gitDir).then(({ type: found }) => found, () => undefined);
  if (type !== 'directory') failed({ code: 'not_a_repository', message: `'${decision.cwd}' is not the root of a git work tree with a .git directory`, details: { repo: decision.cwd } });
  return { path: decision.cwd, file: decision.file };
}

/** The policy's scrubbed environment without any inherited `GIT_*`, plus the variables that pin and harden git. */
async function gitEnvironment(params: { deps: GitDeps; repo: GitRepo }): Promise<Record<string, string>> {
  const { deps: { policy }, repo } = params;
  const { globalConfig } = await gitSandbox();
  const base = Object.fromEntries(Object.entries(policy.environment()).filter(([name]) => !/^GIT_/i.test(name)));
  return {
    ...base,
    GIT_DIR: `${repo.path}${separatorOf(policy.access.platform)}.git`, GIT_WORK_TREE: repo.path,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_ASKPASS: '', SSH_ASKPASS: '',
  };
}

async function spawnGit(params: { deps: GitDeps; repo: GitRepo; argv: string[]; signal: AbortSignal; stdin?: string }): Promise<ProcessResult> {
  const { deps: { policy, runner }, repo, argv, signal, stdin } = params;
  const env = await gitEnvironment(params);
  try {
    return await runner.run({ file: repo.file, args: argv, cwd: repo.path, env, signal, timeoutMs: policy.limits.timeoutMs, maxOutputBytes: policy.limits.maxOutputBytes, ...(stdin == null ? {} : { stdin }) });
  } catch (error) {
    return failed({ code: 'spawn_failed', message: `git could not be started: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** A timeout, a stop or an unexpected exit code is a failure with git's message. */
function checked(params: { result: ProcessResult; args: string[]; okExitCodes: number[] }): ProcessResult {
  const { result, args, okExitCodes } = params;
  const name = args[0] ?? '';
  if (result.timedOut) failed({ code: 'timeout', message: `git ${name} did not finish in time and was stopped` });
  if (result.aborted) failed({ code: 'aborted', message: `git ${name} was stopped because the run was stopped` });
  if (!okExitCodes.includes(result.exitCode ?? -1)) failed({ code: 'git_failed', message: `git ${name} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(0, 500)}`, details: { exitCode: result.exitCode } });
  return result;
}

const asConfig = (entries: string[]): string[] => entries.flatMap(entry => ['-c', entry]);

/**
 * The `name=` overrides for every config key that could run a program. Listing the effective config (NUL separated)
 * runs nothing, and a listing that fails stops the call. A key `-c name=` cannot reach is refused, so git is then not
 * run at all.
 */
async function overridesFor(params: { deps: GitDeps; repo: GitRepo; signal: AbortSignal; hardened: string[] }): Promise<string[]> {
  const { hardened, ...target } = params;
  const args = ['config', '--list', '--name-only', '-z', '--includes'];
  const listed = checked({ result: await spawnGit({ ...target, argv: [...asConfig(hardened), ...args] }), args, okExitCodes: [0] });
  const keys = executingKeys(listed.stdout.split('\0').filter(name => name !== ''));
  const unsafe = unoverridableKeys(keys);
  if (unsafe.length > 0) {
    const shown = unsafe.map(key => `'${key.replace(/[\r\n]/g, ' ').slice(0, 80)}'`).join(', ');
    failed({ category: 'denied', code: 'unsafe_config', message: `The repository config sets ${shown}, which can run a program and cannot be cleared on git's command line (the name holds '=' or a line break), so git was not run`, details: { keys: unsafe } });
  }
  return keys.map(name => `${name}=`);
}

/**
 * Runs git hardened: every config key that could run a program is overridden (found by listing the repository's
 * effective config, which runs nothing), then pager, fsmonitor, hooks, `ext::`, signing and submodule recursion are
 * pinned off, with no optional locks. A timeout, a stop or an unexpected exit code is a failure with git's message.
 */
export async function runGit(call: GitCall): Promise<ProcessResult> {
  const { deps, repo, args, signal, runHooks = false, settings = [], okExitCodes = [0], stdin } = call;
  const { hooksDir } = await gitSandbox();
  const hardened = hardenedSettings({ hooksDir, runHooks });
  const overrides = await overridesFor({ deps, repo, signal, hardened });
  const result = await spawnGit({ deps, repo, signal, argv: [...asConfig([...overrides, ...hardened, ...settings]), '--no-optional-locks', ...args], ...(stdin == null ? {} : { stdin }) });
  return checked({ result, args, okExitCodes });
}
