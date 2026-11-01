import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../security/fs-access-memory.js';
import type { FsAccess } from '../security/fs-access.js';
import { createFileVectorIndex } from './file-vector-index.js';
import { createMemoryVectorIndex } from './memory-vector-index.js';
import { FIXTURE_CHUNKS as CHUNKS, behavesAsAnIndex } from './vector-index-behaviour.test-support.js';

describe('createMemoryVectorIndex', () => {
  behavesAsAnIndex(() => createMemoryVectorIndex());
});

describe('createFileVectorIndex', () => {
  const PATH = '/data/index.jsonl';
  const disk = (): FsAccess => createMemoryFsAccess({ platform: 'posix', files: { '/data': { dir: true } } });
  behavesAsAnIndex(() => createFileVectorIndex({ path: PATH, access: disk() }));

  it('reloads exactly what was written', async () => {
    const access = disk();
    const written = createFileVectorIndex({ path: PATH, access });
    await written.upsert(CHUNKS);
    const reloaded = createFileVectorIndex({ path: PATH, access });
    expect(await reloaded.list()).toEqual(await written.list());
    expect(await reloaded.version()).toBe(await written.version());
  });

  it('keeps the previous state readable when a write crashes, on disk and in memory', async () => {
    const access = disk();
    const index = createFileVectorIndex({ path: PATH, access });
    await index.upsert(CHUNKS.slice(0, 2));
    const before = await index.list();
    for (const crash of ['writeFile', 'rename'] as const) {
      const crashing: FsAccess = { ...access, [crash]: async () => { throw new Error(`disk failed during ${crash}`); } };
      const failing = createFileVectorIndex({ path: PATH, access: crashing });
      await expect(failing.upsert(CHUNKS.slice(2))).rejects.toThrow(crash);
      expect(await failing.list()).toEqual(before);
      expect(await createFileVectorIndex({ path: PATH, access }).list()).toEqual(before);
    }
  });

  it('gives each instance its own temporary file, so two writers never write into the same one (review M9)', async () => {
    const access = disk();
    const temporaries: string[] = [];
    const recording: FsAccess = { ...access, writeFile: async params => { temporaries.push(params.path); return access.writeFile(params); } };
    await createFileVectorIndex({ path: PATH, access: recording }).upsert(CHUNKS.slice(0, 1));
    await createFileVectorIndex({ path: PATH, access: recording }).upsert(CHUNKS.slice(1, 2));
    expect(temporaries).toHaveLength(2);
    expect(new Set(temporaries).size).toBe(2);
    expect(temporaries.every(temporary => temporary.startsWith(`${PATH}.tmp`))).toBe(true);
  });

  it('refuses a corrupt file with the line number', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { [PATH]: '{"chunkId":"x"}\nnot json\n' } });
    await expect(createFileVectorIndex({ path: PATH, access }).list()).rejects.toThrow(/line 2/);
  });
});
