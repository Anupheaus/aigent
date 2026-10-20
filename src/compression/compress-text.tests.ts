import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createWriteQueue } from '../store/write-queue.js';
import { compressText } from './compress-text.js';
import type { CompressTextParams } from './compress-text.js';
import { COMPRESSED_COLLECTION, createCompressionCache } from './compression-cache.js';
import { parseCompressionOptions } from './compression-options.js';
import type { CompressionOptions } from './compressor-types.js';
import { createBrokenCompressor, fakeCompressor } from './fake-compressor.js';
import { findProtectedSpans } from './protect.js';

const PROSE = 'The agent reads the files in the folder and then writes a short report about what it found there for the team. '.repeat(12);
const INSTRUCTION = 'You must not delete anything in src/core and never call DEFAULT_LIMITS more than 3 times. '.repeat(10);

function setup(options: Partial<CompressionOptions> = {}) {
  const store = createInMemoryStore();
  const cache = createCompressionCache({ store, writeQueue: createWriteQueue() });
  const compression = parseCompressionOptions({ agentName: 'a', options: { compressor: fakeCompressor(), minTokens: 10, ...options } })!;
  let clock = 0;
  const run = (text: string, overrides: Partial<CompressTextParams> = {}) => compressText({ text, field: 'context', compression, cache, now: () => (clock += 5), ...overrides });
  return { store, cache, compression, run };
}

describe('compressText', () => {
  it('compresses, caches by key, and serves a byte-identical cache hit the second time', async () => {
    const { store, run } = setup();
    const first = await run(PROSE);
    expect(first).toMatchObject({ cacheHit: false, originalText: PROSE, latencyMs: 5 });
    expect(first.text.length).toBeLessThan(PROSE.length);
    expect(first.compressedTokens).toBeLessThan(first.originalTokens);
    expect(first.ratio).toBeCloseTo(first.compressedTokens / first.originalTokens);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    const second = await run(PROSE);
    expect(second).toMatchObject({ cacheHit: true, text: first.text, key: first.key, latencyMs: 0 });
    expect((await store.list(COMPRESSED_COLLECTION)).map(({ key }) => key)).toEqual([first.key]);
  });

  it('uses a new key when the source, compressor version or parameters change', async () => {
    const base = await setup().run(PROSE);
    expect((await setup().run(`${PROSE}!`)).key).not.toBe(base.key);
    expect((await setup({ compressor: fakeCompressor({ version: '2' }) }).run(PROSE)).key).not.toBe(base.key);
    expect((await setup({ targetRatio: 0.3 }).run(PROSE)).key).not.toBe(base.key);
    expect((await setup({ forceKeep: ['folder'] }).run(PROSE)).key).not.toBe(base.key);
  });

  it('leaves text under minTokens unchanged without calling the compressor', async () => {
    let calls = 0;
    const counting = { id: 'c', version: '1', compress: async ({ text }: { text: string }) => { calls += 1; return { text }; } };
    const result = await setup({ compressor: counting, minTokens: 1_000 }).run(PROSE);
    expect(result).toMatchObject({ text: PROSE, cacheHit: false, ratio: 1 });
    expect(calls).toBe(0);
  });

  it('keeps every protected span and forceKeep entry', async () => {
    const { run } = setup({ forceKeep: ['folder'] });
    const result = await run(`${INSTRUCTION} ${PROSE}`);
    for (const span of [...findProtectedSpans(INSTRUCTION), 'folder']) expect(result.text).toContain(span);
    expect(result.warning).toBeUndefined();
  });

  it('rejects output that dropped protected content, uses the original and warns (also on a cache hit)', async () => {
    const { run } = setup({ compressor: createBrokenCompressor() });
    const result = await run(INSTRUCTION, { field: 'task' });
    expect(result).toMatchObject({ text: INSTRUCTION, ratio: 1, warning: 'Compression of task dropped protected content and was ignored' });
    expect((await run(INSTRUCTION, { field: 'task' }))).toMatchObject({ cacheHit: true, text: INSTRUCTION, warning: expect.stringContaining('dropped protected content') });
  });

  it('checks protected spans as whole words and by count, so a dropped "not" is not hidden by "notes" or a second "not"', async () => {
    const { run } = setup({ compressor: createBrokenCompressor() });
    expect((await run('You must not share these notes with anyone outside the team at all, please.')).warning).toBe('Compression of context dropped protected content and was ignored');
    const dropOne = { id: 'd', version: '1', compress: async ({ text }: { text: string }) => ({ text: text.replace('not ', '') }) };
    expect((await setup({ compressor: dropOne }).run('Do not run it and do not stop it before the whole job has finished running.')).warning).toBeDefined();
  });

  it.each([
    ['a curly-apostrophe negation', 'You don’t delete production data.', 'You delete production data.'],
    ['a contraction outside any list', "The files weren't changed by the job.", 'The files changed by the job.'],
    ['"unless"', 'Approve refunds unless the amount exceeds the limit.', 'Approve refunds.'],
    ['"except"', 'Delete all branches except main.', 'Delete all branches.'],
    ['a minus sign', 'Set the offset to -5 for this run.', 'Set the offset to 5 for this run.'],
    ['"at most"', 'Use at most 3 retries for this job.', 'Use 3 retries for this job.'],
    ['"Avoid"', 'Avoid calling the billing service directly.', 'Try calling the billing service directly.'],
    ['"nothing" and "none"', 'Nothing was found and none of the jobs ran.', 'Was found and of the jobs ran.'],
    ['reordered spans', 'Edit src/app.ts only; never edit src/db.ts.', 'Edit src/db.ts only; never edit src/app.ts.'],
    ['an inserted negation', 'Delete the logs after the export finishes.', 'Do not delete the logs after the export finishes.'],
  ])('rejects output that changed %s', async (_name, source, output) => {
    const rewriting = { id: 'rw', version: '1', compress: async () => ({ text: output }) };
    const text = source.padEnd(source.length + 400, ' ');
    expect((await setup({ compressor: rewriting, minTokens: 0 }).run(text)).warning).toBe('Compression of context dropped protected content and was ignored');
  });

  it('re-checks a cache hit against the current protection rules and recompresses one that fails them', async () => {
    const first = await setup().run(INSTRUCTION);
    // A store shared with an older release (or tampered with) holds an entry that dropped every "not".
    const { cache, run } = setup();
    await cache.set({ key: first.key, entry: { text: INSTRUCTION.replaceAll('not ', ''), isRejected: false, compressorId: 'fake', compressorVersion: '1', recordedAt: 0 } });
    const again = await run(INSTRUCTION);
    expect(again.cacheHit).toBe(false);
    expect(again.text).toBe(first.text);
  });

  it('uses the original with a warning when the compressor throws', async () => {
    const failing = { id: 'f', version: '1', compress: async () => { throw new Error('model missing'); } };
    expect(await setup({ compressor: failing }).run(PROSE)).toMatchObject({ text: PROSE, warning: 'Compression of context failed (model missing) and was ignored' });
  });

  it('times out a compressor that never answers: original with a warning, nothing cached, the compressor told to stop', async () => {
    let seen: AbortSignal | undefined;
    const hung = { id: 'h', version: '1', compress: ({ signal }: { signal?: AbortSignal }) => { seen = signal; return new Promise<{ text: string }>(() => undefined); } };
    const { store, run } = setup({ compressor: hung, timeoutMs: 20 });
    expect(await run(PROSE)).toMatchObject({ text: PROSE, isFailed: true, warning: 'Compression of context failed (the compressor did not answer within 20ms) and was ignored' });
    expect(seen?.aborted).toBe(true);
    expect(await store.list(COMPRESSED_COLLECTION)).toEqual([]);
  });

  it('rejects as aborted as soon as the caller aborts a compressor that never answers', async () => {
    const hung = { id: 'h', version: '1', compress: () => new Promise<{ text: string }>(() => undefined) };
    const controller = new AbortController();
    const pending = setup({ compressor: hung, timeoutMs: 60_000 }).run(PROSE, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('property: protected spans injected into random text survive the fake compressor', async () => {
    const spans = ['not', 'never', '42 ms', 'src/a/b.ts', 'fooBar', 'snake_case_name', '"quoted text"', 'https://x.test/p', '`code()`'];
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(fc.constantFrom(...spans), fc.stringMatching(/^[a-z]{1,8}$/)), { minLength: 40, maxLength: 120 }),
      fc.integer({ min: 2, max: 5 }),
      async (words, dropEvery) => {
        const text = words.join(' ');
        const result = await setup({ compressor: fakeCompressor({ dropEvery }), minTokens: 0 }).run(text);
        expect(result.warning).toBeUndefined();
        for (const span of findProtectedSpans(text)) expect(result.text).toContain(span);
      },
    ), { numRuns: 60 });
  });
});
