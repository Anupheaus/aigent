import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFsPolicy } from './fs-policy.js';
import { scrubEnv } from './scrub-env.js';
import { createShellPolicy } from './shell-policy.js';
import type { ShellPolicyOptions } from './shell-policy-types.js';
import { tempRoot } from './temp-dir.test-support.js';

let root = '';
let cleanup: () => Promise<void> = async () => undefined;
let node = '';

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  await mkdir(join(root, 'ws', 'sub'), { recursive: true });
  await writeFile(join(root, 'ws', 'file.txt'), 'x');
  node = await realpath(process.execPath);
});
afterAll(() => cleanup());

const policyWith = (options: Partial<ShellPolicyOptions> = {}) => createShellPolicy({
  commands: [{ name: 'node', resolvedPath: process.execPath, argRules: { allowSubcommands: undefined, denyArgs: ['--inspect', /^--require/] } }],
  cwdPolicy: createFsPolicy({ roots: [{ path: join(root, 'ws'), permissions: ['read'] }] }),
  ...options,
});

describe('ShellPolicy decisions', () => {
  it('denies everything without commands', async () => {
    expect(await policyWith({ commands: [] }).checkCommand({ command: 'node', args: [] })).toMatchObject({ allowed: false, code: 'no_commands' });
  });

  it('allows an exact command name, resolved to its real executable, in the default working directory', async () => {
    expect(await policyWith().checkCommand({ command: 'node', args: ['-v'] })).toMatchObject({ allowed: true, file: node, args: ['-v'], cwd: join(root, 'ws'), requiresApproval: false });
  });

  it.each(['./node', 'NODE', 'node.exe', 'Node', ' node', 'node ', '/usr/bin/node', 'C:\\node.exe', 'bin/node', '..\\node'])('refuses the bypass spelling %j', async command => {
    expect(await policyWith().checkCommand({ command, args: [] })).toMatchObject({ allowed: false, code: 'command_not_allowed' });
  });

  it('refuses the absolute path of the allowed program itself (only names are accepted)', async () => {
    expect(await policyWith().checkCommand({ command: process.execPath, args: [] })).toMatchObject({ allowed: false, code: 'command_not_allowed' });
  });

  it('finds commands only in searchDirs, never through the parent PATH', async () => {
    const searched = policyWith({ commands: [{ name: 'node' }], searchDirs: [dirname(node)] });
    expect(await searched.checkCommand({ command: 'node', args: [] })).toMatchObject({ allowed: true, file: node });
    // The parent's PATH has node on it, but nothing is configured to search.
    expect(process.env.PATH ?? process.env.Path ?? '').toContain(dirname(process.execPath).slice(0, 3));
    expect(await policyWith({ commands: [{ name: 'node' }] }).checkCommand({ command: 'node', args: [] })).toMatchObject({ allowed: false, code: 'command_not_found' });
  });

  it('refuses an executable whose real file is a different program (strictResolve)', async () => {
    expect(await policyWith({ commands: [{ name: 'git', resolvedPath: process.execPath }] }).checkCommand({ command: 'git', args: [] })).toMatchObject({ allowed: false, code: 'command_mismatch' });
  });

  it('refuses a symlink named like an allowed command that points at another program', async context => {
    const links = join(root, 'links');
    await mkdir(links, { recursive: true });
    const linkName = process.platform === 'win32' ? 'git.exe' : 'git';
    try {
      await symlink(process.execPath, join(links, linkName), 'file');
    } catch (error) {
      context.skip(`file symlinks cannot be created here: ${(error as { code?: string }).code ?? String(error)}`);
      return;
    }
    const policy = policyWith({ commands: [{ name: 'git' }], searchDirs: [links] });
    expect(await policy.checkCommand({ command: 'git', args: [] })).toMatchObject({ allowed: false, code: 'command_mismatch' });
    expect(await policyWith({ commands: [{ name: 'git' }], searchDirs: [links], strictResolve: false }).checkCommand({ command: 'git', args: [] })).toMatchObject({ allowed: true });
  });

  it('runs a copy with the allowed name from a configured directory (the configuration is trusted, the model is not)', async () => {
    const tools = join(root, 'tools');
    await mkdir(tools, { recursive: true });
    const copy = join(tools, process.platform === 'win32' ? 'tool.exe' : 'tool');
    await copyFile(process.execPath, copy);
    expect(await policyWith({ commands: [{ name: 'tool' }], searchDirs: [tools] }).checkCommand({ command: 'tool', args: [] })).toMatchObject({ allowed: true, file: await realpath(copy) });
  });

  it('checks argv: NUL, count, subcommands and denied arguments', async () => {
    const policy = policyWith({ commands: [{ name: 'node', resolvedPath: process.execPath, argRules: { allowSubcommands: ['-v', '-e'], denyArgs: ['--inspect', /^--require/], maxArgs: 3 } }] });
    expect(await policy.checkCommand({ command: 'node', args: ['-e', 'a\0b'] })).toMatchObject({ allowed: false, code: 'invalid_args' });
    expect(await policy.checkCommand({ command: 'node', args: ['-v', 'a', 'b', 'c'] })).toMatchObject({ allowed: false, code: 'invalid_args' });
    expect(await policy.checkCommand({ command: 'node', args: ['script.js'] })).toMatchObject({ allowed: false, code: 'subcommand_not_allowed' });
    expect(await policy.checkCommand({ command: 'node', args: ['-e', '--inspect=9229'] })).toMatchObject({ allowed: false, code: 'denied_arg' });
    expect(await policy.checkCommand({ command: 'node', args: ['-e', '--require-module'] })).toMatchObject({ allowed: false, code: 'denied_arg' });
    expect(await policy.checkCommand({ command: 'node', args: ['-e', 'x'.repeat(31_000)] })).toMatchObject({ allowed: false, code: 'invalid_args' });
  });

  it('keeps shell metacharacters as plain arguments: there is no shell to interpret them', async () => {
    const args = ['; rm -rf /', '&& calc', '| cat', '`id`', '$(id)', 'a\nb', '> out.txt', '*.ts', '--', '-rf', '"quoted"', '$HOME', '%PATH%'];
    expect(await policyWith().checkCommand({ command: 'node', args })).toMatchObject({ allowed: true, args });
  });

  it('checks the working directory through the FsPolicy', async () => {
    const policy = policyWith();
    expect(await policy.checkCommand({ command: 'node', args: [], cwd: 'sub' })).toMatchObject({ allowed: true, cwd: join(root, 'ws', 'sub') });
    expect(await policy.checkCommand({ command: 'node', args: [], cwd: root })).toMatchObject({ allowed: false, code: 'cwd_denied' });
    expect(await policy.checkCommand({ command: 'node', args: [], cwd: 'file.txt' })).toMatchObject({ allowed: false, code: 'cwd_denied' });
    expect(await policy.checkCommand({ command: 'node', args: [], cwd: 'missing' })).toMatchObject({ allowed: false, code: 'cwd_denied' });
  });

  it('works out approval per command, by argv when a predicate is given', async () => {
    const policy = policyWith({ commands: [{ name: 'node', resolvedPath: process.execPath, requiresApproval: argv => argv.includes('-e') }] });
    expect(await policy.checkCommand({ command: 'node', args: ['-e', '1'] })).toMatchObject({ allowed: true, requiresApproval: true });
    expect(await policy.checkCommand({ command: 'node', args: ['-v'] })).toMatchObject({ allowed: true, requiresApproval: false });
  });

  it('refuses invalid definitions', () => {
    const cwdPolicy = createFsPolicy({ roots: [{ path: join(root, 'ws'), permissions: ['read'] }] });
    expect(() => createShellPolicy({ commands: [], cwdPolicy, allowShell: true as unknown as false })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(() => createShellPolicy({ commands: [{ name: '../git' }], cwdPolicy })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(() => createShellPolicy({ commands: [], cwdPolicy, timeoutMs: 600_001 })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });
});

describe('environment scrubbing', () => {
  const secret = ['fake', 'secret', 'value'].join('-');
  const parent = { PATH: '/bin', Home: '/home/u', AWS_SECRET_ACCESS_KEY: secret, GITHUB_TOKEN: secret, NPM_TOKEN: secret, MY_API_KEY: secret, LANG: 'C' };

  it('passes only allowlisted names, case-insensitively on Windows only, and set values win', () => {
    expect(scrubEnv({ parent, spec: { allow: ['PATH', 'HOME', 'LANG'], set: { LANG: 'en_US.UTF-8' } }, platform: 'posix' })).toEqual({ PATH: '/bin', LANG: 'en_US.UTF-8' });
    expect(scrubEnv({ parent, spec: { allow: ['path', 'HOME'], set: { Path: 'C:\\bin' } }, platform: 'win32' })).toEqual({ Home: '/home/u', Path: 'C:\\bin' });
  });

  it('never passes credentials through the default allowlist, and PATH is the configured searchDirs', () => {
    process.env.AIGENT_TEST_TOKEN = secret;
    try {
      const policy = policyWith({ searchDirs: [dirname(node)] });
      const env = policy.environment();
      expect(Object.values(env)).not.toContain(secret);
      expect(Object.keys(env).some(name => /token|secret|key/i.test(name))).toBe(false);
      expect(Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1]).toBe([dirname(node)].join(delimiter));
    } finally {
      delete process.env.AIGENT_TEST_TOKEN;
    }
  });
});
