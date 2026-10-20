import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { PathPlatform } from './fs-access.js';

/** Executable extensions tried on Windows. Batch files (`.cmd`, `.bat`) are never run: they need a shell. */
const WINDOWS_EXTENSIONS = ['.exe', '.com'];

export type ResolvedExecutable = { ok: true; file: string } | { ok: false; code: 'command_not_found' | 'command_mismatch'; message: string };

/** The executable's own name: its basename without a Windows executable extension, case-folded on Windows. */
function nameOf(params: { file: string; platform: PathPlatform }): string {
  const { file, platform } = params;
  if (platform === 'posix') return posix.basename(file);
  const base = win32.basename(file).toLowerCase();
  const extension = WINDOWS_EXTENSIONS.find(candidate => base.endsWith(candidate));
  return extension == null ? base : base.slice(0, -extension.length);
}

async function isExecutableFile(params: { file: string; platform: PathPlatform }): Promise<boolean> {
  const { file, platform } = params;
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform === 'posix') await access(file, constants.X_OK);
    return true;
  } catch {
    // Missing, unreadable or not executable: not a candidate.
    return false;
  }
}

/**
 * Finds the executable for an allowed command: its configured `resolvedPath`, or the first match in `searchDirs`
 * (never the parent's `PATH`). With `strictResolve`, the real path (after symlinks) must still carry the allowed name,
 * so a link named `git` that points at another program is refused.
 */
export async function resolveExecutable(params: { name: string; resolvedPath?: string; searchDirs: readonly string[]; strictResolve: boolean; platform: PathPlatform }): Promise<ResolvedExecutable> {
  const { name, resolvedPath, searchDirs, strictResolve, platform } = params;
  const flavour = platform === 'win32' ? win32 : posix;
  const fileNames = platform === 'win32' ? WINDOWS_EXTENSIONS.map(extension => name + extension) : [name];
  const candidates = resolvedPath != null ? [resolvedPath] : searchDirs.flatMap(directory => fileNames.map(fileName => flavour.join(directory, fileName)));
  for (const candidate of candidates) {
    if (!flavour.isAbsolute(candidate) || !await isExecutableFile({ file: candidate, platform })) continue;
    const real = await realpath(candidate);
    const expected = platform === 'win32' ? name.toLowerCase() : name;
    if (strictResolve && nameOf({ file: real, platform }) !== expected) {
      return { ok: false, code: 'command_mismatch', message: `'${candidate}' resolves to '${real}', which is not '${name}'` };
    }
    return { ok: true, file: real };
  }
  const where = resolvedPath != null ? `'${resolvedPath}'` : searchDirs.length === 0 ? 'no searchDirs are configured' : `searched ${searchDirs.join(', ')}`;
  return { ok: false, code: 'command_not_found', message: `No executable for '${name}' was found (${where})` };
}
