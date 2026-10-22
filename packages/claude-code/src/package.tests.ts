import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from './version.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
/** Reads of a credential store, keychain or login token: the package must never contain them. */
const FORBIDDEN_SOURCE = /\.credentials|keychain|oauth/i;
/** Long enough for a cold TypeScript compile of the package and the core it type-checks against. */
const TSC_TIMEOUT_MS = 120_000;

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.flatMap(entry => (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.tests.') && !entry.name.includes('.test-support.') ? [join(directory, entry.name)] : []));
}

describe('the @anupheaus/aigent-claude-code package', () => {
  it('is private (never published) until the owner confirms the policy position', async () => {
    const manifest = await json(join(PACKAGE_ROOT, 'package.json'));
    expect(manifest).toMatchObject({ name: '@anupheaus/aigent-claude-code', private: true, version: PACKAGE_VERSION });
    expect(manifest.publishConfig).toBeUndefined();
    expect((manifest.peerDependenciesMeta as Record<string, { optional?: boolean }>)['@anthropic-ai/claude-agent-sdk']?.optional).toBe(true);
  });

  it('never reads credential files, keychains or login tokens (source scan)', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(PACKAGE_ROOT, 'src'))) {
      if (FORBIDDEN_SOURCE.test(await readFile(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('is left out of the core package: not in its files or exports, and never a dependency of it', async () => {
    const core = await json(join(REPO_ROOT, 'package.json'));
    expect(core.files).toEqual(['dist']);
    expect(JSON.stringify(core.exports)).not.toContain('packages/');
    expect(JSON.stringify({ ...core.dependencies as object, ...core.peerDependencies as object })).not.toContain('claude');
  });

  it('type-checks standalone (tsc -p packages/claude-code)', async () => {
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const { stdout } = await promisify(execFile)(process.execPath, [tsc, '-p', PACKAGE_ROOT], { cwd: REPO_ROOT, timeout: TSC_TIMEOUT_MS });
    expect(stdout.trim()).toBe('');
  }, TSC_TIMEOUT_MS);
});
