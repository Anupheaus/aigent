import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from '../../tool-types.js';
import { callTool, CONTEXT, findGit, git, itemsOf, scriptedRepo, toolsFor } from './git-repo.test-support.js';
import type { GitWriteOptions } from './index.js';

const gitPath = findGit();
let setup: Awaited<ReturnType<typeof scriptedRepo>>;
const undoContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', effectId: 'e1', signal: new AbortController().signal };

const head = (): string => git({ cwd: setup.repo, args: ['rev-parse', 'HEAD'] }).trim();
const toolsWith = (enableWrites: GitWriteOptions): Map<string, Tool> => toolsFor({ workspace: setup.workspace, gitPath: gitPath as string, enableWrites });
const resultOf = (executed: Awaited<ReturnType<typeof callTool>>) => (executed.envelope.ok ? executed.envelope.result as Record<string, unknown> : { error: executed.envelope.error });

describe.skipIf(gitPath == null)(`git write tools${gitPath == null ? ' (skipped: git is not installed)' : ''}`, () => {
  beforeEach(async () => { setup = await scriptedRepo(); });
  afterEach(() => setup.cleanup());

  it('registers git_commit and git_push only when enabled, both always asking for approval', () => {
    const tools = toolsWith({ commit: true, push: { remotes: ['origin'], branches: ['main'] } });
    expect([...tools.keys()]).toEqual(['git_status', 'git_diff', 'git_log', 'git_blame', 'git_commit', 'git_push']);
    expect(tools.get('git_commit')).toMatchObject({ hasSideEffects: true, risk: 'medium', resume: 'verify', requiresApproval: { reason: expect.any(String) } });
    expect(tools.get('git_push')).toMatchObject({ hasSideEffects: true, risk: 'high', requiresApproval: { reason: expect.any(String) } });
    expect(tools.get('git_push')?.applyUndo).toBeUndefined();
  });

  it('git_commit: a dry run changes nothing; a commit takes exactly the listed paths; undo soft-resets', async () => {
    const commit = toolsWith({ commit: true }).get('git_commit') as Tool;
    const before = head();
    const planned = await callTool({ tool: commit, args: { repo: 'repo', message: 'change b', paths: ['b.txt'] }, context: { dryRun: true } });
    expect(planned.plannedEffects).toEqual([expect.objectContaining({ kind: 'git.commit', reversible: true })]);
    expect(head()).toBe(before);
    const executed = await callTool({ tool: commit, args: { repo: 'repo', message: 'change b', paths: ['b.txt'] } });
    expect(resultOf(executed)).toMatchObject({ parent: before, paths: ['b.txt'] });
    expect(git({ cwd: setup.repo, args: ['show', '--name-only', '--format=%s', 'HEAD'] }).trim().split('\n')).toEqual(['change b', '', 'b.txt']);
    // d.txt was staged before and stays staged, not committed; c.txt stays untracked.
    expect(git({ cwd: setup.repo, args: ['status', '--porcelain'] })).toContain('A  d.txt');
    expect(await commit.verify?.({ repo: 'repo', message: 'change b', paths: ['b.txt'] }, CONTEXT)).toEqual({ done: true });
    expect(await commit.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toEqual({ ok: true });
    expect(head()).toBe(before);
    expect(git({ cwd: setup.repo, args: ['status', '--porcelain'] })).toContain('M  b.txt');
  });

  it('git_commit: refuses paths outside the repository, and undo leaves a HEAD that moved on alone', async () => {
    const commit = toolsWith({ commit: true }).get('git_commit') as Tool;
    expect(resultOf(await callTool({ tool: commit, args: { repo: 'repo', message: 'x', paths: ['../escape.txt'] } }))).toMatchObject({ error: { code: 'outside_repository' } });
    const executed = await callTool({ tool: commit, args: { repo: 'repo', message: 'change b', paths: ['b.txt'] } });
    git({ cwd: setup.repo, args: ['commit', '-q', '-m', 'later', '--', 'd.txt'] });
    expect(await commit.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toMatchObject({ ok: false, message: expect.stringContaining('left alone') });
  });

  it('git_commit runs no hooks unless runHooks is set', async () => {
    const marker = join(setup.root, 'hooked.txt');
    await writeFile(join(setup.repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho hooked > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    await callTool({ tool: toolsWith({ commit: true }).get('git_commit') as Tool, args: { repo: 'repo', message: 'quiet', paths: ['b.txt'] } });
    expect(existsSync(marker)).toBe(false);
    await writeFile(join(setup.repo, 'b.txt'), 'again\n');
    await callTool({ tool: toolsWith({ commit: { runHooks: true } }).get('git_commit') as Tool, args: { repo: 'repo', message: 'hooked', paths: ['b.txt'] } });
    expect(existsSync(marker)).toBe(true);
  });

  it('git_push: only allowed remotes and branches, never forced; a dry run pushes nothing', async () => {
    const remote = join(setup.root, 'remote.git');
    git({ cwd: setup.root, args: ['init', '-q', '--bare', remote] });
    git({ cwd: setup.repo, args: ['remote', 'add', 'origin', remote] });
    git({ cwd: setup.repo, args: ['remote', 'add', 'other', remote] });
    const push = toolsWith({ push: { remotes: ['origin'], branches: ['main'] } }).get('git_push') as Tool;
    expect(resultOf(await callTool({ tool: push, args: { repo: 'repo', remote: 'other', branch: 'main' } }))).toMatchObject({ error: { code: 'remote_not_allowed' } });
    expect(resultOf(await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: 'dev' } }))).toMatchObject({ error: { code: 'branch_not_allowed' } });
    expect(resultOf(await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: '+main' } }))).toMatchObject({ error: { code: 'invalid_ref' } });
    expect(resultOf(await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: 'main', force: true } }))).toMatchObject({ error: { code: 'invalid_arguments' } });
    await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: 'main' }, context: { dryRun: true } });
    expect(git({ cwd: setup.root, args: [`--git-dir=${remote}`, 'branch', '--list'] }).trim()).toBe('');
    await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: 'main' } });
    expect(git({ cwd: setup.root, args: [`--git-dir=${remote}`, 'rev-parse', 'main'] }).trim()).toBe(head());
    // Rewrite local history: the push is not a fast-forward, so git refuses it (nothing forces it).
    git({ cwd: setup.repo, args: ['reset', '-q', '--hard', setup.commits[1] as string] });
    git({ cwd: setup.repo, args: ['commit', '-q', '--allow-empty', '-m', 'diverged'] });
    expect(resultOf(await callTool({ tool: push, args: { repo: 'repo', remote: 'origin', branch: 'main' } }))).toMatchObject({ error: { code: 'git_failed' } });
    expect(git({ cwd: setup.root, args: [`--git-dir=${remote}`, 'rev-parse', 'main'] }).trim()).toBe(setup.commits[0]);
  });
});
