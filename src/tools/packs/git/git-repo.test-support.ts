import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createShellPolicy } from '../../../security/shell-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { executeToolCall } from '../../execute-tool-call.js';
import type { ExecutedToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { gitTools } from './index.js';
import type { GitWriteOptions } from './index.js';

/** The real git on PATH, or undefined (the git tests are then skipped with this reason). */
export function findGit(): string | undefined {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    for (const name of names) if (directory !== '' && existsSync(join(directory, name))) return join(directory, name);
  }
  return undefined;
}

export const IDENTITY = { name: 'Test Author', email: 'author@example.test' };
const FIXED_DATE = '2024-01-02T03:04:05+00:00';

/** Runs the real git for test setup only, with fixed identity and dates and no system or user config. */
export function git(params: { cwd: string; args: string[]; env?: Record<string, string> }): string {
  const { cwd, args, env = {} } = params;
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd, '..', 'empty-gitconfig'),
      GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, ...env,
    },
  });
}

/** A temp workspace holding repository `repo` with two commits, then a modified, an untracked and a staged file. */
export async function scriptedRepo(): Promise<{ root: string; workspace: string; repo: string; commits: string[]; cleanup(): Promise<void> }> {
  const { root, cleanup } = await tempRoot();
  const workspace = join(root, 'ws');
  const repo = join(workspace, 'repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(workspace, 'empty-gitconfig'), '');
  await writeFile(join(root, 'empty-gitconfig'), '');
  git({ cwd: repo, args: ['init', '-q'] });
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'b.txt'), 'bee\n');
  git({ cwd: repo, args: ['add', '.'] });
  git({ cwd: repo, args: ['commit', '-q', '-m', 'first commit'] });
  await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git({ cwd: repo, args: ['commit', '-q', '-am', 'second commit'] });
  await writeFile(join(repo, 'b.txt'), 'bee changed\n');
  await writeFile(join(repo, 'c.txt'), 'untracked\n');
  await writeFile(join(repo, 'd.txt'), 'staged\n');
  git({ cwd: repo, args: ['add', 'd.txt'] });
  const commits = git({ cwd: repo, args: ['rev-list', 'HEAD'] }).trim().split('\n');
  return { root, workspace, repo, commits, cleanup };
}

/** The git pack over `workspace` (read and write) with the real git and the test identity. */
export function toolsFor(params: { workspace: string; gitPath: string; enableWrites?: GitWriteOptions }): Map<string, Tool> {
  const { workspace, gitPath, enableWrites } = params;
  const policy = createShellPolicy({ commands: [{ name: 'git', resolvedPath: gitPath }], cwdPolicy: createFsPolicy({ roots: [{ path: workspace, permissions: ['read', 'write'] }] }) });
  return new Map(gitTools({ policy, identity: IDENTITY, ...(enableWrites == null ? {} : { enableWrites }) }).map(tool => [tool.name, tool]));
}

export const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal, idempotencyKey: 'r:c1' };

export function callTool(params: { tool: Tool; args: unknown; context?: Partial<ToolContext> }): Promise<ExecutedToolCall> {
  const { tool, args, context = {} } = params;
  return executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c1', name: tool.name, args }, context: { ...CONTEXT, ...context }, now: () => 0 });
}

/** The per-item entries of a batch call (throws when the whole call failed). */
export function itemsOf(executed: ExecutedToolCall): { ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }[] {
  if (!executed.envelope.ok) throw new Error(`call failed: ${executed.envelope.error.message}`);
  return executed.envelope.result as never;
}
