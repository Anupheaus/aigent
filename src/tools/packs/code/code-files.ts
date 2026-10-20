import { createHash } from 'node:crypto';
import type { FsAccess } from '../../../security/fs-access.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import { createIgnoreMatcher, DEFAULT_SEARCH_IGNORES, parseIgnoreFile } from '../../../security/ignore-rules.js';
import { createSkipReport, walk } from '../fs/fs-walk.js';
import type { WalkEntry } from '../fs/fs-walk.js';

/** Files the code tools understand: TypeScript and JavaScript, with JSX and module variants (declarations included). */
export const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
/** Deepest directory level walked under a root. */
const MAX_WALK_DEPTH = 64;

/** A root's code files as last listed: what the program is built from, and the token that changes with any of them. */
export interface CodeFileList {
  entries: WalkEntry[];
  /** sha-256 over every file's path, mtime and size: any edit, addition or removal changes it. */
  version: string;
  /** More code files than `maxFiles` (or a walk cut at the policy's `maxFiles`): the rest are not in the program. */
  truncated: boolean;
  /** Counted skips (with samples): ignored, hidden, denied, too large, unreadable. */
  skipped: ReturnType<typeof createSkipReport>;
}

/**
 * Every code file under `root` the policy lets the tools read, in a stable order, without dependency, build or VCS
 * directories (skips are counted), at most `maxFiles` of them. Symlinks are not followed.
 */
export async function listCodeFiles(params: { policy: FsPolicy; access: FsAccess; root: string; maxFiles: number }): Promise<CodeFileList> {
  const { policy, access, root, maxFiles } = params;
  const skipped = createSkipReport();
  const ignore = createIgnoreMatcher({ rules: DEFAULT_SEARCH_IGNORES.flatMap(parseIgnoreFile), caseSensitive: policy.caseSensitive(access) });
  const walked = await walk({
    deps: { policy, access, approvals: 'none', clock: { now: () => 0 } }, start: root, root, maxDepth: MAX_WALK_DEPTH, includeHidden: false, ignore,
    maxEntries: policy.limits.maxFiles, skipped,
  });
  const code = walked.entries.filter(({ type, path }) => type === 'file' && CODE_FILE.test(path));
  const tooLarge = code.filter(({ size }) => size > policy.limits.maxReadBytes);
  for (const { relative } of tooLarge) skipped.add('tooLarge', relative);
  const readable = code.filter(({ size }) => size <= policy.limits.maxReadBytes);
  const entries = readable.slice(0, maxFiles);
  const version = createHash('sha256').update(entries.map(({ path, mtimeMs, size }) => `${path}\u0000${mtimeMs}\u0000${size}`).join('\n')).digest('hex');
  return { entries, version, truncated: walked.truncated || readable.length > maxFiles, skipped };
}
