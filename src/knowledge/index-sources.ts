import type { FsAccess } from '../security/fs-access.js';
import type { FsPolicy } from '../security/fs-policy-types.js';
import type { Chunker, Embedder, IndexedChunk, IndexReport, KnowledgeSource, VectorIndex } from './knowledge-types.js';
import { readSource, statSource } from './source-scan.js';
import { sha256 } from './vector-index.js';

/** What indexing works with. */
export interface IndexDeps {
  embedder: Embedder;
  index: VectorIndex;
  chunker: Chunker;
  fs?: { access: FsAccess; policy: FsPolicy };
}

/** Vectors by content hash of everything in the index made by this embedder, loaded once per `index` call. */
interface VectorCache {
  load(): Promise<Map<string, number[]>>;
}

function vectorCache(deps: IndexDeps): VectorCache {
  let known: Promise<Map<string, number[]>> | undefined;
  return {
    load: () => (known ??= deps.index.list().then(chunks => new Map(chunks.filter(chunk => chunk.embedderId === deps.embedder.id && chunk.vector != null).map(chunk => [chunk.contentHash, chunk.vector as number[]])))),
  };
}

type SourceOutcome =
  | { kind: 'skipped' }
  | { kind: 'failed'; code: string; message: string; removed?: number }
  | { kind: 'indexed'; written: number; removed: number; embedded: number };

/** The source's text (with mtime for path sources), `skipped` when its mtime is unchanged, or why it failed. */
async function textOf(params: { deps: IndexDeps; source: KnowledgeSource; existing: IndexedChunk[] }): Promise<{ text: string; mtimeMs?: number } | SourceOutcome> {
  const { deps: { fs, embedder }, source: { text, path }, existing } = params;
  if (typeof text === 'string' && path == null) return { text };
  if (typeof path !== 'string' || text != null) return { kind: 'failed', code: 'invalid_source', message: 'a source needs exactly one of text or path' };
  if (fs == null) return { kind: 'failed', code: 'no_fs', message: `path source '${path}' needs createKnowledgeBase({ fs: { access, policy } })` };
  const stat = await statSource({ fs, path });
  if (!stat.ok) return { kind: 'failed', code: stat.code, message: stat.message };
  const [first] = existing;
  if (first != null && first.sourceMtimeMs === stat.mtimeMs && existing.every(chunk => chunk.embedderId === embedder.id)) return { kind: 'skipped' };
  const read = await readSource({ fs, path });
  return read.ok ? { text: read.text, mtimeMs: read.mtimeMs } : { kind: 'failed', code: read.code, message: read.message };
}

/** The source's new chunks, without vectors. */
function chunksOf(params: { deps: IndexDeps; source: KnowledgeSource; text: string; sourceHash: string; mtimeMs?: number }): IndexedChunk[] {
  const { deps: { chunker, embedder }, source: { id, uri, metadata = {} }, text, sourceHash, mtimeMs } = params;
  return chunker({ text, uri }).map(({ start, end, startLine, endLine, metadata: pieceMetadata = {} }) => {
    const chunkText = text.slice(start, end);
    return {
      chunkId: sha256(`${id}\n${start}:${end}\n${chunkText}`), sourceId: id, uri,
      span: { start, end, ...(startLine == null ? {} : { startLine }), ...(endLine == null ? {} : { endLine }) },
      text: chunkText, metadata: { ...metadata, ...pieceMetadata }, contentHash: sha256(chunkText), sourceHash,
      ...(mtimeMs == null ? {} : { sourceMtimeMs: mtimeMs }), embedderId: embedder.id,
    };
  });
}

async function indexOne(params: { deps: IndexDeps; source: KnowledgeSource; signal?: AbortSignal; vectors: VectorCache }): Promise<SourceOutcome> {
  const { deps, source, signal, vectors: cache } = params;
  const { index, embedder } = deps;
  if (typeof source?.id !== 'string' || source.id === '' || typeof source.uri !== 'string' || source.uri === '') return { kind: 'failed', code: 'invalid_source', message: 'a source needs a non-empty id and uri' };
  const existing = await index.list(source.id);
  const read = await textOf({ deps, source, existing });
  if ('kind' in read && read.kind === 'failed' && existing.length > 0) {
    // A source that can no longer be read must not keep serving its old chunks.
    await index.remove({ sourceId: source.id });
    return { ...read, removed: existing.length };
  }
  if ('kind' in read) return read;
  const sourceHash = sha256(read.text);
  const isCurrent = existing.length > 0 && existing.every(chunk => chunk.sourceHash === sourceHash && chunk.embedderId === embedder.id);
  if (isCurrent) return { kind: 'skipped' };
  const chunks = chunksOf({ deps, source, text: read.text, sourceHash, ...(read.mtimeMs == null ? {} : { mtimeMs: read.mtimeMs }) });
  // Text already embedded anywhere in the index (matched by content hash) keeps its vector: only new text is embedded.
  const known = await cache.load();
  const missing = [...new Map(chunks.filter(chunk => !known.has(chunk.contentHash)).map(chunk => [chunk.contentHash, chunk.text]))];
  const vectors = missing.length === 0 ? [] : await embedder.embed(missing.map(([, text]) => text), signal);
  missing.forEach(([hash], position) => known.set(hash, vectors[position] ?? []));
  const fresh = new Set(chunks.map(({ chunkId }) => chunkId));
  const stale = existing.filter(({ chunkId }) => !fresh.has(chunkId)).map(({ chunkId }) => chunkId);
  if (chunks.length > 0) await index.upsert(chunks.map(chunk => ({ ...chunk, vector: known.get(chunk.contentHash) ?? [] })));
  if (stale.length > 0) await index.remove({ chunkIds: stale });
  return { kind: 'indexed', written: chunks.length, removed: stale.length, embedded: missing.length };
}

/** Indexes each source in order (see `KnowledgeBase.index`); with `prune`, sources not listed are dropped. */
export async function indexSources(params: { deps: IndexDeps; request: { sources: KnowledgeSource[]; prune?: boolean; signal?: AbortSignal } }): Promise<IndexReport> {
  const { deps, request: { sources, prune = false, signal } } = params;
  const vectors = vectorCache(deps);
  const report: IndexReport = { indexed: [], skipped: [], failed: [], removed: [], chunksWritten: 0, chunksRemoved: 0, embedded: 0 };
  for (const source of sources) {
    signal?.throwIfAborted();
    const outcome = await indexOne({ deps, source, vectors, ...(signal == null ? {} : { signal }) });
    if (outcome.kind === 'skipped') report.skipped.push(source.id);
    else if (outcome.kind === 'failed') {
      report.failed.push({ sourceId: String(source?.id), code: outcome.code, message: outcome.message });
      report.chunksRemoved += outcome.removed ?? 0;
    } else {
      report.indexed.push(source.id);
      report.chunksWritten += outcome.written;
      report.chunksRemoved += outcome.removed;
      report.embedded += outcome.embedded;
    }
  }
  if (!prune) return report;
  const listed = new Set(sources.map(({ id }) => id));
  const indexed = [...new Set((await deps.index.list()).map(({ sourceId }) => sourceId))].filter(id => !listed.has(id));
  for (const sourceId of indexed) {
    report.chunksRemoved += (await deps.index.list(sourceId)).length;
    await deps.index.remove({ sourceId });
    report.removed.push(sourceId);
  }
  return report;
}
