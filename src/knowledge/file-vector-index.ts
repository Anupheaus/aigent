import { randomUUID } from 'node:crypto';
import { createAigentError } from '../core/aigent-error.js';
import { fsErrorCode } from '../security/fs-access.js';
import type { FsAccess } from '../security/fs-access.js';
import type { IndexedChunk, VectorIndex } from './knowledge-types.js';
import { createChunkStoreIndex } from './memory-vector-index.js';

/** `createFileVectorIndex(options)`. */
export interface FileVectorIndexOptions {
  /** Absolute path of the JSON-lines file (one chunk per line). */
  path: string;
  /** The disk (`createNodeFsAccess()`) or a fake; the file is written only through it. */
  access: FsAccess;
}

const TEMP_SUFFIX = '.tmp';

function parseLines(params: { text: string; path: string }): IndexedChunk[] {
  const { text, path } = params;
  return text.split('\n').filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line) as IndexedChunk;
    } catch (error) {
      throw createAigentError({ code: 'invalid_input', message: `Vector index file '${path}' line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`, details: { path, line: index + 1 } });
    }
  });
}

/**
 * A `VectorIndex` kept in a JSON-lines file and in memory. Every change rewrites the file atomically: the new content
 * goes to a temporary file that is then renamed over the old one, so a crash at any point leaves the previous (or the
 * new) state readable, never a partial one. A failed write leaves the index unchanged.
 *
 * Single writer: the file is loaded once per instance and each change rewrites the whole snapshot, so two instances
 * (or processes) writing the same file lose each other's changes. Give one instance the file, and share it.
 * The rename is not preceded by an fsync, so a power loss (not a process crash) can still lose the latest change.
 */
export function createFileVectorIndex(options: FileVectorIndexOptions): VectorIndex {
  const { path, access } = options;
  // Unique per instance: two instances over one file never write into the same temporary file.
  const instanceId = randomUUID();
  let writes = 0;
  return createChunkStoreIndex({
    load: async () => {
      try {
        return parseLines({ text: new TextDecoder().decode(await access.readFile(path)), path });
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    persist: async chunks => {
      writes += 1;
      const temporary = `${path}${TEMP_SUFFIX}-${instanceId}-${writes}`;
      const text = chunks.map(chunk => JSON.stringify(chunk)).join('\n');
      await access.writeFile({ path: temporary, data: new TextEncoder().encode(text === '' ? '' : `${text}\n`) });
      try {
        await access.rename(temporary, path);
      } catch (error) {
        await access.rm(temporary).catch(() => undefined);
        throw error;
      }
    },
  });
}
