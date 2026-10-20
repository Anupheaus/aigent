import type { FsAccess } from './fs-access.js';
import type { FsPolicy } from './fs-policy-types.js';
import type { EnvSpec } from './scrub-env.js';

/** Argument rules for one allowed command. */
export interface ArgRules {
  /** The first argument must be one of these (e.g. `['status', 'log']` for git). */
  allowSubcommands?: string[];
  /** Arguments refused: a string matches the argument exactly or as `<string>=...`; a RegExp is tested on each. */
  denyArgs?: (string | RegExp)[];
  /** Most arguments (default `DEFAULT_MAX_ARGS`). */
  maxArgs?: number;
}

/** A program the shell pack may run. */
export interface AllowedCommand {
  /** The bare name the model uses and the executable's basename (e.g. `git`; `git.exe` on Windows). */
  name: string;
  /** Absolute path of the executable; without it, the name is looked up in `ShellPolicyOptions.searchDirs` only. */
  resolvedPath?: string;
  argRules?: ArgRules;
  /** Whether a call needs a person's approval (always, or by its argv). */
  requiresApproval?: boolean | ((argv: readonly string[]) => boolean);
}

/** `createShellPolicy(options)`. Deny by default: without commands every request is refused. */
export interface ShellPolicyOptions {
  commands: AllowedCommand[];
  /** The working directory must pass this policy's `read` check (default cwd: its first root). */
  cwdPolicy: FsPolicy;
  /** For the cwd checks; default the real disk. */
  access?: FsAccess;
  /** Nothing ever runs through a shell: argv is always passed literally. */
  allowShell?: false;
  /** The child's environment (default: `DEFAULT_ENV_ALLOW`, nothing set). `PATH` becomes `searchDirs` when given. */
  env?: EnvSpec;
  /** Directories (absolute) searched for commands without `resolvedPath`; the parent's `PATH` is never searched. */
  searchDirs?: string[];
  /** Default true: the executable's real path (after links) must still have the allowed name. */
  strictResolve?: boolean;
  /** Per output stream (default 200_000). */
  maxOutputBytes?: number;
  /** Default 30_000, at most `MAX_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Most processes running at once through tools using this policy (default 4). */
  maxConcurrent?: number;
}

/** Why a command was refused. */
export type CommandDenialCode = 'no_commands' | 'command_not_allowed' | 'command_not_found' | 'command_mismatch' | 'invalid_args' | 'subcommand_not_allowed' | 'denied_arg' | 'cwd_denied';

export type CommandDecision =
  | {
    allowed: true;
    /** Absolute path of the executable to spawn. */
    file: string;
    args: string[];
    /** Canonical working directory. */
    cwd: string;
    command: AllowedCommand;
    requiresApproval: boolean;
  }
  | { allowed: false; code: CommandDenialCode; message: string; suggestion?: string };

/** The only authority on which programs the shell and git packs may run, with what arguments and where. */
export interface ShellPolicy {
  checkCommand(request: { command: string; args: readonly string[]; cwd?: string }): Promise<CommandDecision>;
  /** The scrubbed environment every child gets. */
  environment(): Record<string, string>;
  limits: { maxOutputBytes: number; timeoutMs: number; maxConcurrent: number };
  cwdPolicy: FsPolicy;
  access: FsAccess;
}
