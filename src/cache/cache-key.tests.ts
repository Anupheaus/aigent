import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { computeCacheKey } from './cache-key.js';

const HEX_SHA_256 = /^[0-9a-f]{64}$/;

const readArgs = z.object({ path: z.string(), options: z.object({ encoding: z.string(), limit: z.number() }).strict() }).strict();

function readTool(overrides: Partial<Parameters<typeof defineTool<typeof readArgs>>[0]> = {}): Tool {
  return defineTool({
    name: 'read', description: 'Read a file', args: readArgs, deterministic: true, cache: true,
    describeActivity: () => ({ title: 'read' }), run: async () => 'contents', ...overrides,
  });
}

describe('computeCacheKey', () => {
  it('is a lowercase hex sha-256', () => {
    expect(computeCacheKey({ tool: readTool(), args: { path: 'a', options: { encoding: 'utf8', limit: 1 } } })).toMatch(HEX_SHA_256);
  });

  it('does not depend on argument key order, at any depth', () => {
    const tool = readTool();
    const first = computeCacheKey({ tool, args: { path: 'a', options: { encoding: 'utf8', limit: 1 } } });
    const second = computeCacheKey({ tool, args: { options: { limit: 1, encoding: 'utf8' }, path: 'a' } });
    expect(second).toBe(first);
  });

  it('property: any key permutation of the same arguments gives the same key', () => {
    const tool = readTool();
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.integer()), record => {
      const reversed = Object.fromEntries(Object.entries(record).reverse());
      expect(computeCacheKey({ tool, args: reversed })).toBe(computeCacheKey({ tool, args: record }));
    }));
  });

  it('changes with the argument values (the validity token is kept on the entry, not in the key)', () => {
    const tool = readTool();
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    const base = computeCacheKey({ tool, args });
    expect(computeCacheKey({ tool, args: { ...args, path: 'b' } })).not.toBe(base);
  });

  it('changes with the description, so a tool documented as doing something else never shares entries', () => {
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    expect(computeCacheKey({ tool: readTool({ description: 'Read a file from repo B' }), args })).not.toBe(computeCacheKey({ tool: readTool(), args }));
  });

  it('separates two definitions of the same tool only when definition scoped (instance entries)', () => {
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    const [first, second] = [readTool(), readTool()];
    expect(computeCacheKey({ tool: first!, args })).toBe(computeCacheKey({ tool: second!, args }));
    expect(computeCacheKey({ tool: first!, args, isDefinitionScoped: true })).not.toBe(computeCacheKey({ tool: second!, args, isDefinitionScoped: true }));
    expect(computeCacheKey({ tool: withFeedbackFields(first!), args, isDefinitionScoped: true })).toBe(computeCacheKey({ tool: first!, args, isDefinitionScoped: true }));
  });

  it('applies the cacheKey normaliser', () => {
    const tool = readTool({ cacheKey: args => ({ path: args.path.toLowerCase() }) });
    const upper = computeCacheKey({ tool, args: { path: 'A.TXT', options: { encoding: 'utf8', limit: 1 } } });
    const lower = computeCacheKey({ tool, args: { path: 'a.txt', options: { encoding: 'latin1', limit: 9 } } });
    expect(upper).toBe(lower);
  });

  it('separates tool versions and argument schemas of the same tool name', () => {
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    const base = computeCacheKey({ tool: readTool(), args });
    expect(computeCacheKey({ tool: readTool({ version: '2' }), args })).not.toBe(base);
    const widened = defineTool({
      name: 'read', description: 'Read a file', args: readArgs.extend({ follow: z.boolean().optional() }).strict(), deterministic: true, cache: true,
      describeActivity: () => ({ title: 'read' }), run: async () => 'contents',
    });
    expect(computeCacheKey({ tool: widened, args })).not.toBe(base);
  });

  it('ignores the feedback previous field added to the schema the model sees', () => {
    const tool = readTool();
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    expect(computeCacheKey({ tool: withFeedbackFields(tool), args })).toBe(computeCacheKey({ tool, args }));
  });

  it('keeps tools of different names apart', () => {
    const args = { path: 'a', options: { encoding: 'utf8', limit: 1 } };
    const other = defineTool({ name: 'stat', description: 'Read a file', args: readArgs, deterministic: true, cache: true, describeActivity: () => ({ title: 's' }), run: async () => 1 });
    expect(computeCacheKey({ tool: other, args })).not.toBe(computeCacheKey({ tool: readTool(), args }));
  });
});
