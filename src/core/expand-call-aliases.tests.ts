import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAliasTable, expandAliases } from '../shapers/alias-table.js';
import type { AliasTable } from '../shapers/alias-table.js';
import { VERBATIM_CORPUS } from '../shapers/verbatim-corpus.test-support.js';
import { defineTool } from '../tools/define-tool.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { expandCallAliases } from './expand-call-aliases.js';

const LONG_PATH = 'src/components/theme/ThemeProvider.tsx';

function tool(params: { name: string; acceptsAliases?: boolean }) {
  const { name, acceptsAliases } = params;
  return defineTool({
    name, description: name, args: z.object({ path: z.string(), content: z.string() }).strict(), deterministic: false, cache: false,
    ...(acceptsAliases == null ? {} : { acceptsAliases }), describeActivity: () => ({ title: name }), run: async () => 'ok',
  });
}

const registry = createToolRegistry([tool({ name: 'read_file', acceptsAliases: true }), tool({ name: 'write_file' })]);

function populatedTable(): AliasTable {
  const aliases = createAliasTable({ minLength: 1 });
  aliases.aliasFor(LONG_PATH);
  return aliases;
}

describe('expandCallAliases', () => {
  it('expands exact issued aliases for a tool that opted in, leaving substrings and unknown tokens alone', () => {
    const call = { id: 'c', name: 'read_file', args: { path: 'F1', content: 'see F1 and F2' } };
    expect(expandCallAliases({ call, registry, aliases: populatedTable() }).args).toEqual({ path: LONG_PATH, content: 'see F1 and F2' });
  });

  it('passes every corpus file through unchanged to a tool that did not opt in, with the alias table populated', () => {
    const aliases = populatedTable();
    for (const [path, content] of Object.entries(VERBATIM_CORPUS)) {
      const call = { id: 'c', name: 'write_file', args: { path, content } };
      expect(expandCallAliases({ call, registry, aliases }).args).toEqual({ path, content });
    }
  });

  it('expands inner aigent_multi calls by their own tool, and leaves unknown tools alone', () => {
    const call = { id: 'm', name: MULTI_TOOL_NAME, args: { calls: [
      { id: 'a', tool: 'read_file', args: { path: 'F1', content: 'x' } },
      { id: 'b', tool: 'write_file', args: { path: 'F1', content: 'F1' } },
      { id: 'c', tool: 'nope', args: { path: 'F1' } },
    ] } };
    expect(expandCallAliases({ call, registry, aliases: populatedTable() }).args).toEqual({ calls: [
      { id: 'a', tool: 'read_file', args: { path: LONG_PATH, content: 'x' } },
      { id: 'b', tool: 'write_file', args: { path: 'F1', content: 'F1' } },
      { id: 'c', tool: 'nope', args: { path: 'F1' } },
    ] });
  });

  // Mutation check: without the opt-in guard, the corpus test above would fail, so it is not true by construction.
  it('mutation check: unguarded expansion would rewrite the corpus file whose content is exactly F1', () => {
    const aliases = populatedTable();
    const altered = Object.entries(VERBATIM_CORPUS).filter(([path, content]) => JSON.stringify(expandAliases({ path, content }, aliases)) !== JSON.stringify({ path, content }));
    expect(altered.map(([path]) => path)).toEqual(['alias-token']);
  });
});
