import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from '../../tool-types.js';
import { callTool, findGit, git, itemsOf, scriptedRepo, toolsFor } from './git-repo.test-support.js';

const gitPath = findGit();
const GIT_TEST_TIMEOUT_MS = 60_000;
let setup: Awaited<ReturnType<typeof scriptedRepo>>;
let marker = '';
let command = '';

const tool = (name: string): Tool => toolsFor({ workspace: setup.workspace, gitPath: gitPath as string }).get(name) as Tool;

/** Runs plain git (the control) and reports whether it ran the planted program, then removes the marker. */
async function plainGitRuns(params: { cwd: string; args: string[] }): Promise<boolean> {
  git(params);
  const isPwned = existsSync(marker);
  await rm(marker, { force: true });
  return isPwned;
}

describe.skipIf(gitPath == null)(`git hardening against hostile repository config${gitPath == null ? ' (skipped: git is not installed)' : ''}`, () => {
  beforeEach(async () => {
    setup = await scriptedRepo();
    marker = join(setup.root, 'pwned.txt');
    const script = join(setup.root, 'pwn.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdin.pipe(process.stdout);`);
    command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
  }, GIT_TEST_TIMEOUT_MS);
  afterEach(() => setup.cleanup());

  it('never runs a filter whose name holds "=" (git would split its -c override at that "=")', async () => {
    git({ cwd: setup.repo, args: ['config', 'filter.ev=il.clean', command] });
    await writeFile(join(setup.repo, '.git', 'info', 'attributes'), '* filter=ev=il\n');
    expect(await plainGitRuns({ cwd: setup.repo, args: ['diff', '--', 'b.txt'] })).toBe(true);
    const [status] = itemsOf(await callTool({ tool: tool('git_status'), args: { items: [{ repo: 'repo' }] } }));
    const [diff] = itemsOf(await callTool({ tool: tool('git_diff'), args: { items: [{ repo: 'repo' }] } }));
    expect(existsSync(marker)).toBe(false);
    expect(status?.error).toMatchObject({ code: 'unsafe_config' });
    expect(diff?.error).toMatchObject({ code: 'unsafe_config', message: expect.stringContaining('filter.ev=il.clean') });
  }, GIT_TEST_TIMEOUT_MS);

  it('never runs a submodule\'s own filter or textconv during status and diff', async () => {
    const source = join(setup.root, 'sub-source');
    await mkdir(source);
    git({ cwd: source, args: ['init', '-q'] });
    await writeFile(join(source, 'inner.txt'), 'aaa\n');
    git({ cwd: source, args: ['add', '.'] });
    git({ cwd: source, args: ['commit', '-q', '-m', 'inner'] });
    git({ cwd: setup.repo, args: ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.replace(/\\/g, '/'), 'sub'] });
    git({ cwd: setup.repo, args: ['commit', '-q', '-m', 'add sub'] });
    const sub = join(setup.repo, 'sub');
    git({ cwd: sub, args: ['config', 'filter.evil.clean', command] });
    git({ cwd: sub, args: ['config', 'diff.evil.textconv', command] });
    await appendFile(join(setup.repo, '.git', 'modules', 'sub', 'info', 'attributes'), '* filter=evil diff=evil\n').catch(async () => {
      await mkdir(join(setup.repo, '.git', 'modules', 'sub', 'info'), { recursive: true });
      await writeFile(join(setup.repo, '.git', 'modules', 'sub', 'info', 'attributes'), '* filter=evil diff=evil\n');
    });
    git({ cwd: setup.repo, args: ['config', 'diff.submodule', 'diff'] });
    // Same size, new content: git must read (and so clean) the file to see the change.
    await writeFile(join(sub, 'inner.txt'), 'bbb\n');
    expect(await plainGitRuns({ cwd: setup.repo, args: ['status', '--porcelain'] })).toBe(true);
    expect(await plainGitRuns({ cwd: setup.repo, args: ['diff'] })).toBe(true);
    const [status] = itemsOf(await callTool({ tool: tool('git_status'), args: { items: [{ repo: 'repo' }] } }));
    const [diff] = itemsOf(await callTool({ tool: tool('git_diff'), args: { items: [{ repo: 'repo' }] } }));
    expect(status?.ok).toBe(true);
    expect(diff?.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});
