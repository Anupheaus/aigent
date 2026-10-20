import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temp directory (canonical, so comparisons with realpath hold), removed by `cleanup`. */
export async function tempRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aigent-fs-')));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
