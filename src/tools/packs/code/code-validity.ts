import { baseName } from '../fs/fs-shared.js';
import type { CodeDeps } from './code-shared.js';

/**
 * The cache token of a code call: per root its paths touch, the hash of every code file's mtime and size, so a cached
 * answer is never served after any file of the program changed (or a path became denied).
 */
export async function codeValidity(params: { deps: CodeDeps; paths: string[] }): Promise<string> {
  const { deps: { policy, access, programs }, paths } = params;
  const roots = new Set<string>();
  const tokens: string[] = [];
  for (const path of paths) {
    const decision = await policy.check({ path, permission: 'read', access });
    if (!decision.allowed) tokens.push(`denied:${decision.code}`);
    else roots.add(decision.root);
  }
  for (const root of [...roots].sort()) tokens.push(`${root}:${await programs.versionOf(root)}`);
  return tokens.join('|');
}

/** "Outlining a.ts" for one path, "Outlining 3 files" for several. */
export function pathsTitle(params: { verb: string; paths: string[] }): string {
  const { verb, paths } = params;
  const [only] = paths;
  return paths.length === 1 && only != null ? `${verb} ${baseName(only)}` : `${verb} ${paths.length} files`;
}
