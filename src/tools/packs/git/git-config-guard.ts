import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Config keys whose value is a program git may run (or that sends output through one): filters, diff drivers, merge
 * drivers, pagers, editors, credential helpers, signing programs, ssh and proxy commands, fsmonitor, hooks, remote
 * helpers. A repository's own config can set any of them, so each one found is overridden with an empty value.
 */
const EXECUTING_KEY = /\.(clean|smudge|process|textconv|command|driver|program|helper|editor|pager|sshcommand|gitproxy|askpass|fsmonitor|hookspath|alternaterefscommand|receivepack|uploadpack|packobjectshook|external)$/i;
const PAGER_SECTION = /^pager\./i;

/** Every key the repository's effective config sets that could run a program. */
export function executingKeys(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => EXECUTING_KEY.test(name) || PAGER_SECTION.test(name)))];
}

/** The empty hooks directory and empty global config every git call points at (created once per process). */
export interface GitSandbox {
  hooksDir: string;
  globalConfig: string;
}

let sandbox: Promise<GitSandbox> | undefined;

export function gitSandbox(): Promise<GitSandbox> {
  sandbox ??= (async () => {
    const base = await mkdtemp(join(tmpdir(), 'aigent-git-'));
    const hooksDir = join(base, 'hooks');
    const globalConfig = join(base, 'global-config');
    await mkdir(hooksDir);
    await writeFile(globalConfig, '');
    return { hooksDir, globalConfig };
  })();
  return sandbox;
}

/**
 * The `-c` settings every call carries after the overrides: no pager, no fsmonitor, hooks from an empty directory
 * (unless `runHooks`), no `ext::` transport, no signatures or colour, and no credential prompts.
 */
export function hardenedSettings(params: { hooksDir: string; runHooks: boolean }): string[] {
  const { hooksDir, runHooks } = params;
  return [
    'core.pager=cat', 'core.fsmonitor=false', ...(runHooks ? [] : [`core.hooksPath=${hooksDir}`]), 'protocol.ext.allow=never',
    'log.showSignature=false', 'commit.gpgSign=false', 'tag.gpgSign=false', 'color.ui=false', 'core.quotePath=false', 'credential.helper=',
  ];
}
