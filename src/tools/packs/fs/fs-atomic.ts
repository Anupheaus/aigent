import { fsErrorCode } from '../../../security/fs-access.js';
import type { FsDeps } from './fs-shared.js';
import { baseName } from './fs-shared.js';

/** Makes temp names unique within this process. */
let tempCount = 0;

function siblingOf(params: { path: string; name: string; platform: 'posix' | 'win32' }): string {
  const { path, name, platform } = params;
  const separator = platform === 'win32' ? '\\' : '/';
  return `${path.slice(0, path.lastIndexOf(separator))}${separator}${name}`;
}

/**
 * Replaces (or creates) `path` all at once: the content goes to a temp file beside it, which is then renamed over it,
 * so a reader never sees a half-written file and a failure leaves the old content in place.
 */
export async function writeAtomically(params: { deps: FsDeps; path: string; data: Uint8Array }): Promise<void> {
  const { deps: { access, clock }, path, data } = params;
  tempCount += 1;
  const temp = siblingOf({ path, name: `.${baseName(path)}.aigent-${clock.now()}-${tempCount}.tmp`, platform: access.platform });
  await access.writeFile({ path: temp, data, exclusive: true });
  try {
    await access.rename(temp, path);
  } catch (error) {
    await access.rm(temp).catch(() => undefined);
    throw error;
  }
}

/** Whether something is at `path` (a broken symlink counts). */
export async function pathExists(params: { deps: FsDeps; path: string }): Promise<boolean> {
  const { deps: { access }, path } = params;
  try {
    await access.lstat(path);
    return true;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** The parent directory of a canonical path. */
export function parentOf(params: { path: string; platform: 'posix' | 'win32' }): string {
  const { path, platform } = params;
  const separator = platform === 'win32' ? '\\' : '/';
  const parent = path.slice(0, path.lastIndexOf(separator));
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? parent + separator : parent;
}
