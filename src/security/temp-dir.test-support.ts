import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Windows keeps a deleted file listed while another handle is still open, so removal retries briefly (EBUSY, ENOTEMPTY, EPERM). */
const REMOVE_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;

/** A fresh temp directory (canonical, so comparisons with realpath hold), removed by `cleanup`. */
export async function tempRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aigent-fs-')));
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS }) };
}
