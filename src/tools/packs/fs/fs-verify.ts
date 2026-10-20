import type { FsFileHandle } from '../../../security/fs-access.js';
import { comparable } from '../../../security/path-flavour.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolFailure } from '../../tool-failure.js';
import type { FsDeps } from './fs-shared.js';

/** Bytes read from an open handle at a time. */
const READ_CHUNK_BYTES = 1_048_576;

/**
 * Check-then-use defences. The policy checks a canonical path, but the OS resolves the string again when it is used,
 * so a directory on the way swapped for a link or junction in between (by another process, or a concurrent tool call)
 * could redirect the operation. These helpers re-verify immediately before and after each use:
 * - reads open first, then check that the path still resolves to itself and that the open handle is the file now at
 *   that path (`fileId` of `fstat` against `stat`), so the bytes returned are the checked file's;
 * - writes check the parent before writing, again after the temp file is written (removing it if the parent moved)
 *   and the target after the rename, so a swap is detected and reported as `path_changed`.
 * Residual limits: Node has no handle-relative (`openat`) or no-follow operations, so a swap that lands exactly
 * between the last check and the operation can still redirect that one operation (it is then reported, but a write
 * that already landed elsewhere cannot always be undone safely), and hard links are indistinguishable from the file.
 */
export function pathChanged(path: string): ToolFailure {
  return toolFailure({ category: 'denied', code: 'path_changed', retryable: false, message: `'${path}' no longer resolves to the path that was checked: a directory on the way was replaced (perhaps by a link) after the check, so the operation was refused`, suggestion: 'Check the path again (fs_stat) and retry if it is still the one intended', details: { path } });
}

/** Refuses when `path` (which must exist) no longer resolves to itself. */
export async function assertResolvesTo(params: { deps: FsDeps; path: string }): Promise<void> {
  const { deps: { access, policy }, path } = params;
  const real = await access.realpath(path);
  const caseSensitive = policy.caseSensitive(access);
  if (comparable({ path: real, caseSensitive }) !== comparable({ path, caseSensitive })) throw pathChanged(path);
}

/** Opens `path` for reading, then proves the handle is the file at the checked path; closes it and refuses otherwise. */
export async function openVerified(params: { deps: FsDeps; path: string }): Promise<FsFileHandle> {
  const { deps, path } = params;
  const handle = await deps.access.open(path);
  try {
    await assertResolvesTo({ deps, path });
    if (handle.stat != null) {
      const [opened, named] = await Promise.all([handle.stat(), deps.access.stat(path)]);
      if (opened.fileId != null && named.fileId != null && opened.fileId !== named.fileId) throw pathChanged(path);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The whole file, read through a verified handle. */
export async function readVerified(params: { deps: FsDeps; path: string }): Promise<Uint8Array> {
  const handle = await openVerified(params);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let chunk = await handle.read({ offset: 0, length: READ_CHUNK_BYTES }); chunk.length > 0; chunk = await handle.read({ offset: total, length: READ_CHUNK_BYTES })) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const whole = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
    return whole;
  } finally {
    await handle.close();
  }
}

/** Makes `work` wait for the mutating fs calls already running on the same tools, so they never race each other. */
const locks = new WeakMap<FsDeps, Promise<unknown>>();

export function serialised<T>(params: { deps: FsDeps; work(): Promise<T> }): Promise<T> {
  const { deps, work } = params;
  const previous = locks.get(deps) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(deps, next.catch(() => undefined));
  return next;
}
