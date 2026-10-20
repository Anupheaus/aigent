import { describe, expect, it } from 'vitest';
import { compressionVersionInput, isFieldCompressed, parseCompressionOptions } from './compression-options.js';
import type { CompressionOptions } from './compressor-types.js';
import { createBrokenCompressor, fakeCompressor } from './fake-compressor.js';

const compressor = fakeCompressor();

describe('parseCompressionOptions', () => {
  it('is undefined without options and fills the defaults: persona and skillset off, the rest on', () => {
    expect(parseCompressionOptions({ agentName: 'a', options: undefined })).toBeUndefined();
    const resolved = parseCompressionOptions({ agentName: 'a', options: { compressor } })!;
    expect(resolved).toMatchObject({ targetRatio: 0.5, minTokens: 200, applyTo: ['toolResults'], forceKeep: [] });
    expect(resolved.fields).toEqual({ persona: false, skillset: false, context: true, task: true, references: true, examples: true });
    expect(isFieldCompressed({ compression: resolved, field: 'persona' })).toBe(false);
    expect(isFieldCompressed({ compression: resolved, field: 'context' })).toBe(true);
    expect(isFieldCompressed({ compression: parseCompressionOptions({ agentName: 'a', options: { compressor, fields: { persona: true } } })!, field: 'persona' })).toBe(true);
  });

  it.each([
    [{ compressor: { id: '', version: '1', compress: compressor.compress } }, /compressor must have/],
    [{ compressor, targetRatio: 1 }, /targetRatio/],
    [{ compressor, minTokens: -1 }, /minTokens/],
    [{ compressor, fields: { tools: true } }, /unknown field 'tools'/],
    [{ compressor, applyTo: ['memory'] }, /unknown applyTo 'memory'/],
    [{ compressor, forceKeep: [''] }, /forceKeep/],
  ])('rejects %o', (options, message) => {
    expect(() => parseCompressionOptions({ agentName: 'w', options: options as unknown as CompressionOptions })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringMatching(message) }));
  });

  it('versions by compressor id and version and every output-changing parameter', () => {
    const input = (options: Partial<CompressionOptions>) => compressionVersionInput(parseCompressionOptions({ agentName: 'a', options: { compressor, ...options } })!);
    expect(input({})).toEqual(input({}));
    expect(input({ compressor: fakeCompressor({ version: '2' }) })).not.toEqual(input({}));
    expect(input({ compressor: createBrokenCompressor() })).not.toEqual(input({}));
    expect(input({ targetRatio: 0.4 })).not.toEqual(input({}));
    expect(input({ fields: { persona: true } })).not.toEqual(input({}));
  });
});

describe('fakeCompressor', () => {
  it('is deterministic and keeps protected text byte for byte', async () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const once = await compressor.compress({ text, targetRatio: 0.5, protect: ['gamma delta'] });
    expect(once).toEqual(await compressor.compress({ text, targetRatio: 0.5, protect: ['gamma delta'] }));
    // A dropped word takes the whitespace after it with it; the space before a dropped last word stays.
    expect(once.text).toBe('alpha gamma delta epsilon eta ');
  });
});
