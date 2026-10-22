import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '../../tool-types.js';
import { callTool, CONTEXT, findGit, git, IDENTITY, itemsOf, scriptedRepo, toolsFor } from './git-repo.test-support.js';

const gitPath = findGit();
const HEAVY_TEST_TIMEOUT_MS = 30_000;
let setup: Awaited<ReturnType<typeof scriptedRepo>>;
let tools: Map<string, Tool>;
const tool = (name: string): Tool => tools.get(name) as Tool;

describe.skipIf(gitPath == null)(`git read tools against a real repository${gitPath == null ? ' (skipped: git is not installed)' : ''}`, () => {
  beforeAll(async () => {
    setup = await scriptedRepo();
    tools = toolsFor({ workspace: setup.workspace, gitPath: gitPath as string });
  });
  afterAll(() => setup.cleanup());

  it('registers only the read tools by default', () => {
    expect([...tools.keys()]).toEqual(['git_status', 'git_diff', 'git_log', 'git_blame']);
  });

  it('git_status: branch and every changed path, as git reports them', async () => {
    const [entry] = itemsOf(await callTool({ tool: tool('git_status'), args: { items: [{ repo: 'repo' }] } }));
    expect(entry?.result).toMatchObject({ repo: setup.repo, branch: 'main', commit: setup.commits[0], ahead: 0, behind: 0 });
    expect(entry?.result?.entries).toEqual(expect.arrayContaining([
      { path: 'b.txt', index: '.', worktree: 'M' }, { path: 'c.txt', index: '?', worktree: '?' }, { path: 'd.txt', index: 'A', worktree: '.' },
    ]));
  });

  it('git_log: commits with hashes, authors, dates and subjects matching rev-list', async () => {
    const [entry] = itemsOf(await callTool({ tool: tool('git_log'), args: { items: [{ repo: 'repo' }, { repo: 'repo', author: 'Test', grep: 'first' }] } }));
    expect(entry?.result?.commits).toEqual(setup.commits.map((hash, index) => ({ hash, author: `${IDENTITY.name} <${IDENTITY.email}>`, date: '2024-01-02T03:04:05Z', subject: index === 0 ? 'second commit' : 'first commit' })));
    const [, filtered] = itemsOf(await callTool({ tool: tool('git_log'), args: { items: [{ repo: 'repo' }, { repo: 'repo', author: 'Test', grep: 'first' }] } }));
    expect((filtered?.result?.commits as { subject: string }[]).map(({ subject }) => subject)).toEqual(['first commit']);
  });

  it('git_diff: work tree, staged and between commits, with stats, equal to git\'s own output', async () => {
    const [first, second] = [setup.commits[1] as string, setup.commits[0] as string];
    const [worktree, staged, between] = itemsOf(await callTool({ tool: tool('git_diff'), args: { items: [{ repo: 'repo' }, { repo: 'repo', staged: true }, { repo: 'repo', from: first, to: second, paths: ['a.txt'] }] } }));
    expect(worktree?.result).toMatchObject({ stat: { files: 1, insertions: 1, deletions: 1 }, truncated: false });
    expect(worktree?.result?.diff).toContain('+bee changed');
    expect(staged?.result).toMatchObject({ stat: { files: 1, insertions: 1, deletions: 0 } });
    expect(between?.result?.diff).toBe(git({ cwd: setup.repo, args: ['diff', '--no-color', first, second, '--', 'a.txt'] }));
  });

  it('git_blame: each line with the commit and author that last changed it', async () => {
    const [entry] = itemsOf(await callTool({ tool: tool('git_blame'), args: { items: [{ repo: 'repo', path: 'a.txt' }, { repo: 'repo', path: 'a.txt', startLine: 2, endLine: 2 }] } }));
    expect(entry?.result?.lines).toEqual([
      { line: 1, hash: setup.commits[1], author: `${IDENTITY.name} <${IDENTITY.email}>`, date: '2024-01-02T03:04:05Z', text: 'one' },
      { line: 2, hash: setup.commits[0], author: `${IDENTITY.name} <${IDENTITY.email}>`, date: '2024-01-02T03:04:05Z', text: 'TWO' },
      { line: 3, hash: setup.commits[0], author: `${IDENTITY.name} <${IDENTITY.email}>`, date: '2024-01-02T03:04:05Z', text: 'three' },
    ]);
  });

  it('refuses injected refs and paths before running git', async () => {
    const refs = ['--output=/tmp/x', '-p', ';rm -rf /', 'HEAD..--upload-pack=touch x', '$(id)', 'a\nb', 'HEAD..main', '`id`'];
    const results = itemsOf(await callTool({ tool: tool('git_log'), args: { items: refs.map(ref => ({ repo: 'repo', ref })) } }));
    expect(results.map(({ error }) => error?.code)).toEqual(refs.map(() => 'invalid_ref'));
    const paths = ['-p', ':(top)a.txt', '../outside.txt', 'a\nb', '.git/config', '--output=x'];
    const refused = itemsOf(await callTool({ tool: tool('git_diff'), args: { items: paths.map(path => ({ repo: 'repo', paths: [path] })) } }));
    expect(refused.map(({ error }) => error?.code)).toEqual(['invalid_path', 'invalid_path', 'outside_repository', 'invalid_path', 'denied_glob', 'invalid_path']);
    const [since, author] = itemsOf(await callTool({ tool: tool('git_log'), args: { items: [{ repo: 'repo', since: '--all' }, { repo: 'repo', author: 'a\nb' }] } }));
    expect([since?.error?.code, author?.error?.code]).toEqual(['invalid_since', 'invalid_pattern']);
  });

  it('refuses a repository outside the roots, and a directory that is not a work tree root', async () => {
    const [outside, notRoot] = itemsOf(await callTool({ tool: tool('git_status'), args: { items: [{ repo: setup.root }, { repo: '.' }] } }));
    expect(outside?.error).toMatchObject({ code: 'cwd_denied', category: 'denied' });
    expect(notRoot?.error).toMatchObject({ code: 'not_a_repository' });
  });

  it('cuts a long diff with a marker', async () => {
    await writeFile(join(setup.repo, 'b.txt'), 'line\n'.repeat(5_000));
    const [entry] = itemsOf(await callTool({ tool: tool('git_diff'), args: { items: [{ repo: 'repo', maxBytes: 1_000 }] } }));
    expect(entry?.result).toMatchObject({ truncated: true, diff: expect.stringContaining('[diff cut at 1000 of') });
    await writeFile(join(setup.repo, 'b.txt'), 'bee changed\n');
  });

  it('caches git_log and git_diff only when pinned to full commit hashes', () => {
    const [newest, oldest] = setup.commits as [string, string];
    for (const name of ['git_log', 'git_diff']) expect(tool(name)).toMatchObject({ deterministic: true, cache: true });
    expect(() => tool('git_log').cacheKey?.({ items: [{ ref: newest }] })).not.toThrow();
    expect(() => tool('git_log').cacheKey?.({ items: [{ ref: 'main' }] })).toThrow();
    expect(() => tool('git_log').cacheKey?.({ items: [{ ref: newest, since: '2024-01-01' }] })).toThrow();
    expect(() => tool('git_diff').cacheKey?.({ items: [{ from: oldest, to: newest }] })).not.toThrow();
    expect(() => tool('git_diff').cacheKey?.({ items: [{ from: oldest }] })).toThrow();
    expect(tool('git_status')).toMatchObject({ cache: false });
  });

  it('never runs repository hooks, fsmonitor or filter programs, nor an inherited pager', async () => {
    const marker = join(setup.root, 'pwned.txt');
    const script = join(setup.root, 'pwn.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
    git({ cwd: setup.repo, args: ['config', 'core.fsmonitor', command] });
    git({ cwd: setup.repo, args: ['config', 'filter.evil.clean', command] });
    git({ cwd: setup.repo, args: ['config', 'diff.evil.textconv', command] });
    await writeFile(join(setup.repo, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n');
    for (const hook of ['post-checkout', 'pre-commit', 'post-index-change']) await writeFile(join(setup.repo, '.git', 'hooks', hook), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    // Control: plain git with this config does run the program, so the check below means something.
    git({ cwd: setup.repo, args: ['diff', 'HEAD', '--', 'b.txt'] });
    const isPlainGitPwned = existsSync(marker);
    if (isPlainGitPwned) await import('node:fs/promises').then(({ rm }) => rm(marker));
    process.env.GIT_PAGER = command;
    try {
      await callTool({ tool: tool('git_status'), args: { items: [{ repo: 'repo' }] } });
      await callTool({ tool: tool('git_diff'), args: { items: [{ repo: 'repo' }, { repo: 'repo', from: setup.commits[1], to: setup.commits[0] }] } });
      await callTool({ tool: tool('git_log'), args: { items: [{ repo: 'repo' }] } });
      await callTool({ tool: tool('git_blame'), args: { items: [{ repo: 'repo', path: 'a.txt' }] } });
    } finally {
      delete process.env.GIT_PAGER;
    }
    expect(isPlainGitPwned).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(CONTEXT.signal.aborted).toBe(false);
    // Many git runs, each with its config listing (and on Windows a leftover sweep in the background): slow under load.
  }, HEAVY_TEST_TIMEOUT_MS);
});
