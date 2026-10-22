import { createHash } from 'node:crypto';
import { createAigentError } from '../../../core/aigent-error.js';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsAccess } from '../../../security/fs-access.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import { ignoreMatcherFor } from '../fs/fs-list.js';
import { resolveDeps } from '../fs/fs-shared.js';
import type { FsDeps } from '../fs/fs-shared.js';
import { readVerified } from '../fs/fs-verify.js';
import { createSkipReport, walk } from '../fs/fs-walk.js';
import { analyseContent, cardFor, CONTENT_FACTS_VERSION, languageOf } from './file-cards.js';
import { indexVersion, linkCards } from './index-graph.js';
import type { ContentFacts, FileCard, IndexSnapshot, IndexToolsOptions } from './index-types.js';

/** Store collection holding content facts by facts version, language and content hash. */
export const REPO_INDEX_COLLECTION = 'repo-index';
const MAX_DEPTH = 64;
const BINARY_SAMPLE = 8_000;
/** Snapshots kept by call key (`refreshFor`): a few calls run at once, never more than this. */
const MAX_CALL_SNAPSHOTS = 32;

export interface RepoIndex {
  /** Brings the index up to date (re-reading only files whose size or mtime changed) and returns it. */
  refresh(): Promise<IndexSnapshot>;
  /**
   * The snapshot for one tool call: the first request for `callKey` refreshes, later ones reuse it, so a cached
   * call's validity token and its answer come from one walk and describe the same files.
   */
  refreshFor(callKey: string): Promise<IndexSnapshot>;
  policy: FsPolicy;
  access: FsAccess;
  /** Policy and access as the fs pack's verified reads take them. */
  deps: FsDeps;
}

interface Remembered {
  card: FileCard;
  /** Key of the content facts the card was built from (`factsKey`). */
  key: string;
  facts: ContentFacts;
  size: number;
  mtimeMs: number;
}

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SAMPLE).includes(0);

/**
 * A file's bytes through a verified open (the handle is the checked file), retried once on failure: a transient
 * fault (a file being replaced, a busy share) then costs nothing. Undefined when both reads fail; the caller reports it.
 */
export async function readWithRetry(params: { deps: FsDeps; path: string }): Promise<Uint8Array | undefined> {
  try {
    return await readVerified(params);
  } catch {
    // The one deliberate retry; a second failure is reported as unreadable.
    return readVerified(params).catch(() => undefined);
  }
}

/**
 * Where content facts are cached: they depend on the bytes, the language (a `.md` and a `.ts` with the same bytes
 * differ) and the analysis code (its version), never on the path, whose facts are recomputed for every file.
 */
const factsKey = (params: { hash: string; language: string }): string => `v${CONTENT_FACTS_VERSION}:${params.language}:${params.hash}`;

/**
 * An incremental index of a directory: one card per text file (language, exports, symbols, imports, routes, tags),
 * reused while the file's size and mtime are unchanged. What the content says is cached by content hash and language
 * (renamed and copied files reuse it); what the path says (language, test/mock/story/config tags) is always the
 * file's own. Every path comes from a walk through the policy (deny globs and the default search ignores
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
    const byKey = new Map([...remembered.values()].map(({ key, facts }) => [key, facts]));
    const next = new Map<string, Remembered>();
    const processed: string[] = [];
    for (const entry of walked.entries) {
      if (entry.type !== 'file') continue;
      if (entry.size > policy.limits.maxReadBytes) { skipped.add('tooLarge', entry.relative); continue; }
      const previous = remembered.get(entry.relative);
      if (previous != null && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs) { next.set(entry.relative, previous); continue; }
      const bytes = await readWithRetry({ deps, path: entry.path });
      if (bytes == null) { skipped.add('unreadable', entry.relative); continue; }
      if (isBinary(bytes)) { skipped.add('binary', entry.relative); continue; }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const language = languageOf(entry.relative);
      const key = factsKey({ hash, language });
      const reused = byKey.get(key) ?? (await store?.get<ContentFacts>(REPO_INDEX_COLLECTION, key))?.value;
      const facts = reused ?? analyseContent({ language, text: new TextDecoder().decode(bytes) });
      if (reused == null) {
        processed.push(entry.relative);
        // Another index sharing the store may have written the same facts first: either copy is the same.
        await store?.compareAndSet({ collection: REPO_INDEX_COLLECTION, key, expectedVersion: undefined, value: facts }).catch(() => false);
      }
      byKey.set(key, facts);
      next.set(entry.relative, { card: cardFor({ path: entry.relative, size: entry.size, hash, facts }), key, facts, size: entry.size, mtimeMs: entry.mtimeMs });
    }
    remembered = next;
    const cards = [...next.values()].map(({ card }) => card);
    const { files } = linkCards(cards);
    const occurred = Object.fromEntries(Object.entries(skipped.counts).filter(([, count]) => count > 0));
    return { root: decision.canonicalPath, version: indexVersion(cards), files, processed: processed.sort(), skipped: occurred, unreadable: skipped.samples.unreadable ?? [] };
  }

  // Concurrent calls share one refresh, so a batch of tool calls walks the tree once.
  const refresh = (): Promise<IndexSnapshot> => {
    running ??= rebuild().finally(() => { running = undefined; });
    return running;
  };
  const byCall = new Map<string, Promise<IndexSnapshot>>();
  return {
    policy, access, deps, refresh,
    refreshFor: callKey => {
      const known = byCall.get(callKey);
      if (known != null) return known;
      const snapshot = refresh();
      byCall.set(callKey, snapshot);
      // Oldest first: a map keeps insertion order.
      for (const oldest of byCall.keys()) { if (byCall.size <= MAX_CALL_SNAPSHOTS) break; byCall.delete(oldest); }
      return snapshot;
    },
  };
}
