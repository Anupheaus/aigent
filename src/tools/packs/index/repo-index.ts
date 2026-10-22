import { createHash } from 'node:crypto';
import { createAigentError } from '../../../core/aigent-error.js';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsAccess } from '../../../security/fs-access.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import type { Store } from '../../../store/store-types.js';
import { ignoreMatcherFor } from '../fs/fs-list.js';
import { resolveDeps } from '../fs/fs-shared.js';
import { createSkipReport, walk } from '../fs/fs-walk.js';
import { buildCard } from './file-cards.js';
import { indexVersion, linkCards } from './index-graph.js';
import type { FileCard, IndexSnapshot, IndexToolsOptions } from './index-types.js';

/** Store collection holding cards by content hash. */
export const REPO_INDEX_COLLECTION = 'repo-index';
const MAX_DEPTH = 64;
const BINARY_SAMPLE = 8_000;

export interface RepoIndex {
  /** Brings the index up to date (re-reading only files whose size or mtime changed) and returns it. */
  refresh(): Promise<IndexSnapshot>;
  policy: FsPolicy;
  access: FsAccess;
}

interface Remembered {
  card: FileCard;
  size: number;
  mtimeMs: number;
}

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SAMPLE).includes(0);

/** A card for `hash` from the store, when one was kept there. */
async function storedCard(params: { store?: Store; hash: string; path: string }): Promise<FileCard | undefined> {
  const { store, hash, path } = params;
  const record = await store?.get<FileCard>(REPO_INDEX_COLLECTION, hash);
  return record == null ? undefined : { ...record.value, path };
}

/**
 * An incremental index of a directory: one card per text file (language, exports, symbols, imports, routes, tags),
 * reused while the file's size and mtime are unchanged and, when they changed, while its content hash is; renamed
 * files reuse their card. Every path comes from a walk through the policy (deny globs and the default search ignores
 * apply), so nothing outside the allowed root is ever read.
 */
export function createRepoIndex(options: IndexToolsOptions): RepoIndex {
  const { policy, access = createNodeFsAccess(), store } = options;
  const deps = resolveDeps({ policy, access });
  const root = options.root ?? policy.roots[0]?.path;
  if (root == null) throw createAigentError({ code: 'invalid_definition', message: 'indexTools: the policy has no roots and no root was given', details: { option: 'root' } });
  let remembered = new Map<string, Remembered>();
  let running: Promise<IndexSnapshot> | undefined;

  async function rebuild(): Promise<IndexSnapshot> {
    const decision = await policy.check({ path: root ?? '', permission: 'read', access });
    if (!decision.allowed) throw createAigentError({ code: 'invalid_input', message: `indexTools: '${root}' is not readable under the policy: ${decision.message}`, details: { root } });
    const skipped = createSkipReport();
    const ignore = await ignoreMatcherFor({ deps, directory: decision.canonicalPath, caseSensitive: policy.caseSensitive(access) });
    const walked = await walk({ deps, start: decision.canonicalPath, root: decision.root, maxDepth: MAX_DEPTH, includeHidden: false, ignore, maxEntries: policy.limits.maxFiles, skipped });
    const byHash = new Map([...remembered.values()].map(({ card }) => [card.hash, card]));
    const next = new Map<string, Remembered>();
    const processed: string[] = [];
    for (const entry of walked.entries) {
      if (entry.type !== 'file') continue;
      if (entry.size > policy.limits.maxReadBytes) { skipped.add('tooLarge', entry.relative); continue; }
      const previous = remembered.get(entry.relative);
      if (previous != null && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs) { next.set(entry.relative, previous); continue; }
      const bytes = await access.readFile(entry.path).catch(() => undefined);
      if (bytes == null) { skipped.add('unreadable', entry.relative); continue; }
      if (isBinary(bytes)) { skipped.add('binary', entry.relative); continue; }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const reused = byHash.get(hash) ?? await storedCard({ hash, path: entry.relative, ...(store == null ? {} : { store }) });
      const card = reused == null ? buildCard({ path: entry.relative, text: new TextDecoder().decode(bytes), size: entry.size, hash }) : { ...reused, path: entry.relative };
      if (reused == null) {
        processed.push(entry.relative);
        await store?.compareAndSet({ collection: REPO_INDEX_COLLECTION, key: hash, expectedVersion: undefined, value: card }).catch(() => false);
      }
      next.set(entry.relative, { card, size: entry.size, mtimeMs: entry.mtimeMs });
    }
    remembered = next;
    const cards = [...next.values()].map(({ card }) => card);
    const { files, mountedRouters } = linkCards(cards);
    return { root: decision.canonicalPath, version: indexVersion(cards), files, mountedRouters, processed: processed.sort(), skipped: { ...skipped.counts } };
  }

  return {
    policy, access,
    // Concurrent calls share one refresh, so a batch of tool calls walks the tree once.
    refresh: () => {
      running ??= rebuild().finally(() => { running = undefined; });
      return running;
    },
  };
}
