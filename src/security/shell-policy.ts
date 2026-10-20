import { delimiter } from 'node:path';
import { createAigentError } from '../core/aigent-error.js';
import { createNodeFsAccess } from './fs-access-node.js';
import { resolveExecutable } from './resolve-executable.js';
import { DEFAULT_ENV_ALLOW, scrubEnv } from './scrub-env.js';
import type { AllowedCommand, CommandDecision, ShellPolicy, ShellPolicyOptions } from './shell-policy-types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest timeout a policy may set. */
export const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_CONCURRENT = 4;
/** Default most arguments per command. */
export const DEFAULT_MAX_ARGS = 64;
/** All arguments together: Windows command lines stop at 32,767 characters. */
const MAX_TOTAL_ARG_CHARS = 30_000;
/** A bare command name: no separators, no drive, nothing a shell or path lookup would treat specially. */
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function invalidDefinition(message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `createShellPolicy: ${message}`, details: { option: 'commands' } });
}

function validate(options: ShellPolicyOptions): void {
  const { commands, timeoutMs, allowShell } = options;
  if (allowShell !== undefined && allowShell !== false) invalidDefinition('allowShell can only be false: commands never run through a shell');
  for (const { name } of commands) if (typeof name !== 'string' || !BARE_NAME.test(name)) invalidDefinition(`command name '${String(name)}' must be a bare program name such as 'git'`);
  if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) invalidDefinition(`timeoutMs must be 1..${MAX_TIMEOUT_MS}, got ${timeoutMs}`);
}

type Refusal = Extract<CommandDecision, { allowed: false }>;

/** The first problem with the argv, or undefined. */
function argProblem(params: { command: AllowedCommand; args: readonly unknown[] }): Refusal | undefined {
  const { command: { name, argRules = {} }, args } = params;
  const { allowSubcommands, denyArgs = [], maxArgs = DEFAULT_MAX_ARGS } = argRules;
  if (args.length > maxArgs) return { allowed: false, code: 'invalid_args', message: `'${name}' takes at most ${maxArgs} arguments, got ${args.length}` };
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) return { allowed: false, code: 'invalid_args', message: 'Every argument must be a string without NUL characters' };
  const strings = args as string[];
  if (strings.reduce((total, arg) => total + arg.length + 1, 0) > MAX_TOTAL_ARG_CHARS) return { allowed: false, code: 'invalid_args', message: `The arguments are longer than ${MAX_TOTAL_ARG_CHARS} characters together` };
  if (allowSubcommands != null && !allowSubcommands.includes(strings[0] ?? '')) {
    return { allowed: false, code: 'subcommand_not_allowed', message: `'${name} ${strings[0] ?? ''}' is not allowed`, suggestion: `Allowed: ${allowSubcommands.map(sub => `${name} ${sub}`).join(', ')}` };
  }
  const denied = strings.find(arg => denyArgs.some(rule => (typeof rule === 'string' ? arg === rule || arg.startsWith(`${rule}=`) : rule.test(arg))));
  return denied == null ? undefined : { allowed: false, code: 'denied_arg', message: `The argument '${denied.slice(0, 80)}' is not allowed for '${name}'` };
}

/**
 * The command authority: deny by default. A request names an allowed command exactly (no paths, other case or
 * extensions), its executable is found only through `resolvedPath` or `searchDirs` (and, strictly, must really be
 * that program), its argv is checked against the command's rules, and its working directory must pass the
 * `cwdPolicy` read check. Nothing ever runs through a shell.
 */
export function createShellPolicy(options: ShellPolicyOptions): ShellPolicy {
  validate(options);
  const { commands, cwdPolicy, searchDirs = [], strictResolve = true, env = { allow: DEFAULT_ENV_ALLOW } } = options;
  const access = options.access ?? createNodeFsAccess();
  const limits = { maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT };
  const platform = access.platform;

  async function checkCommand(request: { command: string; args: readonly string[]; cwd?: string }): Promise<CommandDecision> {
    const { command: requested, args, cwd } = request;
    if (commands.length === 0) return { allowed: false, code: 'no_commands', message: 'No commands are allowed, so every command is refused', suggestion: 'Configure createShellPolicy({ commands: [{ name }] }) for the programs the agent may run' };
    // Exact names only: './git', 'GIT', 'git.exe' or '/usr/bin/git' are different requests, all refused.
    const command = commands.find(({ name }) => name === requested);
    if (command == null) return { allowed: false, code: 'command_not_allowed', message: `Command '${String(requested).slice(0, 80)}' is not allowed`, suggestion: `Allowed commands: ${commands.map(({ name }) => name).join(', ')}` };
    const problem = argProblem({ command, args });
    if (problem != null) return problem;
    const resolved = await resolveExecutable({ name: command.name, ...(command.resolvedPath == null ? {} : { resolvedPath: command.resolvedPath }), searchDirs, strictResolve, platform });
    if (!resolved.ok) return { allowed: false, code: resolved.code, message: resolved.message };
    const decision = await cwdPolicy.check({ path: cwd ?? '.', permission: 'read', access });
    if (!decision.allowed) return { allowed: false, code: 'cwd_denied', message: `Working directory refused: ${decision.message}`, ...(decision.suggestion == null ? {} : { suggestion: decision.suggestion }) };
    const isDirectory = await access.stat(decision.canonicalPath).then(({ type }) => type === 'directory', () => false);
    if (!isDirectory) return { allowed: false, code: 'cwd_denied', message: `Working directory '${decision.canonicalPath}' is not an existing directory` };
    const { requiresApproval = false } = command;
    return { allowed: true, file: resolved.file, args: [...args], cwd: decision.canonicalPath, command, requiresApproval: typeof requiresApproval === 'function' ? requiresApproval(args) : requiresApproval };
  }

  function environment(): Record<string, string> {
    // The child searches only the configured directories, never whatever PATH the parent happens to have.
    const set = searchDirs.length === 0 ? env.set : { PATH: searchDirs.join(delimiter), ...env.set };
    const child = scrubEnv({ parent: process.env, spec: { allow: env.allow, ...(set == null ? {} : { set }) }, platform });
    // PATH is always present (empty when nothing allows it): on Windows libuv copies a missing PATH from the parent.
    return Object.keys(child).some(name => name.toUpperCase() === 'PATH') ? child : { ...child, PATH: '' };
  }

  function approvalFor(request: { command: string; args: readonly string[] }): boolean {
    const requiresApproval = commands.find(({ name }) => name === request.command)?.requiresApproval ?? false;
    return typeof requiresApproval === 'function' ? requiresApproval(request.args) : requiresApproval;
  }

  return { checkCommand, approvalFor, environment, limits, cwdPolicy, access };
}
