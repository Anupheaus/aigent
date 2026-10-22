import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from '../../tool-types.js';
import { callTool, findGit, git, itemsOf, scriptedRepo, toolsFor } from './git-repo.test-support.js';

const gitPath = findGit();
const GIT_TEST_TIMEOUT_MS = 60_000;
let setup: Awaited<ReturnType<typeof scriptedRepo>>;

const tool = (name: string): Tool => toolsFor({ workspace: setup.workspace, gitPath: gitPath as string, enableWrites: { commit: true } }).get(name) as Tool;
const head = (): string => git({ cwd: setup.repo, args: ['rev-parse', 'HEAD'] }).trim();
const errorOf = (executed: Awaited<ReturnType<typeof callTool>>): Record<string, unknown> | undefined => (executed.envelope.ok ? undefined : executed.envelope.error as unknown as Record<string, unknown>);

describe.skipIf(gitPath == null)(`git tools and the FsPolicy deny globs${gitPath == null ? ' (skipped: git is not installed)' : ''}`, () => {
  beforeEach(async () => { setup = await scriptedRepo(); }, GIT_TEST_TIMEOUT_MS);
  afterEach(() => setup.cleanup());

  it('git_diff never returns the content of a denied path, whatever the paths and refs', async () => {
    await writeFile(join(setup.repo, '.env'), 'SECRET=one\n');
    await writeFile(join(setup.repo, 'server.key'), 'PRIVATE-ONE\n');
    git({ cwd: setup.repo, args: ['add', '.env', 'server.key'] });
    git({ cwd: setup.repo, args: ['commit', '-q', '-m', 'secrets'] });
    const secrets = head();
    await writeFile(join(setup.repo, '.env'), 'SECRET=two\n');
    await writeFile(join(setup.repo, 'server.key'), 'PRIVATE-TWO\n');
    // Control: plain git shows the secrets in each of these diffs.
    expect(git({ cwd: setup.repo, args: ['diff'] })).toContain('SECRET=two');
    const items = [{ repo: 'repo' }, { repo: 'repo', paths: ['.'] }, { repo: 'repo', from: setup.commits[0], to: secrets }];
    const results = itemsOf(await callTool({ tool: tool('git_diff'), args: { items } }));
    for (const { ok, result } of results) {
      expect(ok).toBe(true);
      expect(result?.diff).not.toMatch(/SECRET|PRIVATE/);
      expect(result?.withheld).toEqual(['.env', 'server.key']);
    }
    const [worktree] = results;
    expect(worktree?.result).toMatchObject({ stat: { files: 1, insertions: 1, deletions: 1 } });
    expect(worktree?.result?.diff).toContain('+bee changed');
  }, GIT_TEST_TIMEOUT_MS);

  it('git_commit refuses a directory holding denied paths and commits or stages nothing', async () => {
    await writeFile(join(setup.repo, '.env'), 'SECRET=one\n');
    await writeFile(join(setup.repo, 'server.key'), 'PRIVATE-ONE\n');
    const before = head();
    const commit = tool('git_commit');
    const refused = errorOf(await callTool({ tool: commit, args: { repo: 'repo', message: 'all', paths: ['.'] } }));
    expect(refused).toMatchObject({ code: 'denied_paths', message: expect.stringContaining('.env') });
    expect(refused?.message).toContain('server.key');
    expect(errorOf(await callTool({ tool: commit, args: { repo: 'repo', message: 'all', paths: ['.'] }, context: { dryRun: true } }))).toMatchObject({ code: 'denied_paths' });
    expect(head()).toBe(before);
    expect(git({ cwd: setup.repo, args: ['status', '--porcelain'] })).toContain('?? .env');
  }, GIT_TEST_TIMEOUT_MS);

  it('git_commit of a directory commits exactly its changed paths, listed in the result', async () => {
    const commit = tool('git_commit');
    const planned = await callTool({ tool: commit, args: { repo: 'repo', message: 'all', paths: ['.'] }, context: { dryRun: true } });
    expect(planned.envelope.ok).toBe(true);
    const executed = await callTool({ tool: commit, args: { repo: 'repo', message: 'all', paths: ['.'] } });
    const { paths } = (executed.envelope.ok ? executed.envelope.result : {}) as { paths?: string[] };
    expect([...paths ?? []].sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(git({ cwd: setup.repo, args: ['show', '--name-only', '--format=%s', 'HEAD'] }).trim().split('\n')).toEqual(['all', '', 'b.txt', 'c.txt', 'd.txt']);
    expect(errorOf(await callTool({ tool: commit, args: { repo: 'repo', message: 'nothing', paths: ['a.txt'] } }))).toMatchObject({ code: 'nothing_to_commit' });
  }, GIT_TEST_TIMEOUT_MS);
});
