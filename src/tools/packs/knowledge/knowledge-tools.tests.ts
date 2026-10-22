import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../../core/aigent-error.js';
import { fixtureBase } from '../../../knowledge/knowledge-base.test-support.js';
import { executeToolCall } from '../../execute-tool-call.js';
import type { ExecutedToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { evalRetrieval, knowledgeTools } from './index.js';
import type { KnowledgeBase, KnowledgeToolsOptions } from './index.js';
import { JUDGMENTS } from '../../../knowledge/fixtures.test-support.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal };

async function tools(options: Partial<KnowledgeToolsOptions> = {}): Promise<{ search: Tool; read: Tool; base: KnowledgeBase }> {
  const { base } = await fixtureBase();
  const [search, read] = knowledgeTools({ base, ...options });
  return { search: search as Tool, read: read as Tool, base };
}

async function call(params: { tool: Tool; items: unknown[] }): Promise<ExecutedToolCall> {
  const { tool, items } = params;
  return executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c1', name: tool.name, args: { items } }, context: CONTEXT, now: () => 0 });
}

interface Entry {
  ok: boolean;
  result?: Record<string, unknown> & { results?: Record<string, unknown>[] };
  error?: { category: string; code: string };
}

function entries(executed: ExecutedToolCall): Entry[] {
  if (!executed.envelope.ok) throw new Error(executed.envelope.error.message);
  return executed.envelope.result as Entry[];
}

describe('knowledgeTools: contract', () => {
  it('registers knowledge_search and knowledge_read as deterministic, globally cached, verbatim search hits with one shared citation addendum', async () => {
    const { search, read } = await tools();
    for (const tool of [search, read]) {
      expect(tool).toMatchObject({ deterministic: true, cache: true, sharedCache: true, contentKind: 'search-hits', fidelity: 'verbatim', hasSideEffects: false });
      expect(tool.promptAddendum).toContain('[[cite:<chunkId>]]');
    }
    expect([search.name, read.name]).toEqual(['knowledge_search', 'knowledge_read']);
    expect(search.promptAddendum).toBe(read.promptAddendum);
  });

  it('registers nothing without a base, and refuses bad options', async () => {
    expect(knowledgeTools({})).toEqual([]);
    const { base } = await fixtureBase();
    for (const options of [{ base: {} as KnowledgeBase }, { base, maxResults: 21 }, { base, maxResultTokens: 0 }]) {
      try {
        knowledgeTools(options);
        throw new Error('expected a definition error');
      } catch (error) {
        expect(isAigentError(error) && error.code === 'invalid_definition').toBe(true);
      }
    }
  });

  it('keys the cache on normalised arguments and validates entries by the index version', async () => {
    const { search, base } = await tools();
    expect(search.cacheKey?.({ items: [{ query: '  backups ', filter: '{"b":1,"a":2}' }] })).toEqual(search.cacheKey?.({ items: [{ query: 'backups', k: 5, mode: 'hybrid', filter: '{ "a": 2, "b": 1 }' }] }));
    expect(await search.validity?.({ items: [] }, CONTEXT)).toBe(await base.version());
  });
});

describe('knowledge_search', () => {
  it('returns ranked hits with snippets and citations, and honours filters', async () => {
    const { search } = await tools();
    const [backups, billing] = entries(await call({ tool: search, items: [{ query: 'how long are backups kept', k: 3 }, { query: 'cost', filter: '{"topic":"billing"}' }] }));
    const [top] = backups?.result?.results ?? [];
    expect(top).toMatchObject({ sourceId: 'db-backups.md', citation: { sourceId: 'db-backups.md', chunkId: top?.chunkId } });
    expect(backups?.result).toMatchObject({ query: 'how long are backups kept', truncated: false });
    expect((billing?.result?.results ?? []).every(({ sourceId }) => String(sourceId).startsWith('billing-'))).toBe(true);
  });

  it('refuses malformed filters per item', async () => {
    const { search } = await tools();
    const [bad, nested] = entries(await call({ tool: search, items: [{ query: 'x', filter: '{"topic":' }, { query: 'x', filter: '{"topic":{"$ne":"a"}}' }] }));
    expect([bad?.error?.code, nested?.error?.code]).toEqual(['invalid_json', 'invalid_filter']);
  });

  it('drops the lowest-ranked results first to fit the result budget, with a marker', async () => {
    const { search } = await tools({ maxResultTokens: 300 });
    const [entry] = entries(await call({ tool: search, items: [{ query: 'lumen configuration and deployment', k: 10 }] }));
    const results = entry?.result?.results ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(10);
    expect(entry?.result).toMatchObject({ truncated: true, note: expect.stringContaining('lowest-ranked') });
    const full = entries(await call({ tool: (await tools()).search, items: [{ query: 'lumen configuration and deployment', k: 10 }] }))[0]?.result?.results ?? [];
    expect(results.map(({ chunkId }) => chunkId)).toEqual(full.slice(0, results.length).map(({ chunkId }) => chunkId));
  });

  it('reports the citations of its results for the answer post-processor', async () => {
    const { search } = await tools();
    const executed = await call({ tool: search, items: [{ query: 'webhook signature', k: 2 }] });
    const citations = search.citations?.(executed.envelope.ok ? executed.envelope.result : undefined) ?? [];
    expect(citations.length).toBe(2);
    expect(citations[0]).toMatchObject({ sourceId: 'webhooks.md', uri: 'docs/webhooks.md' });
  });
});

describe('knowledge_read', () => {
  it('reads a passage by chunk id or span with its neighbours, and fails clearly otherwise', async () => {
    const { search, read, base } = await tools();
    await base.index({ sources: [{ id: 'long.txt', uri: 'long.txt', text: Array.from({ length: 30 }, (_, index) => `Paragraph ${index} talks about sailing boats and harbour rules in plain words.`).join('\n\n') }] });
    const hits = entries(await call({ tool: search, items: [{ query: 'sailing harbour', k: 10, filter: '{"sourceId":"long.txt"}' }] }))[0]?.result?.results ?? [];
    const reads = entries(await call({ tool: read, items: hits.map(({ chunkId }) => ({ chunkId })) }));
    const middle = reads.find(({ result }) => result?.prev != null && result.next != null)?.result;
    expect(middle).toMatchObject({ sourceId: 'long.txt', text: expect.stringContaining('Paragraph'), citation: { chunkId: middle?.chunkId } });
    const span = middle?.span as { start: number; end: number };
    const [bySpan, bad, missing] = entries(await call({ tool: read, items: [{ sourceId: 'long.txt', start: span.start, end: span.end }, { chunkId: 'x', sourceId: 'long.txt' }, { chunkId: 'nope' }] }));
    expect(bySpan?.result?.chunkId).toBe(middle?.chunkId);
    expect(bad?.error).toMatchObject({ category: 'validation', code: 'invalid_target' });
    expect(missing?.error).toMatchObject({ code: 'not_found' });
  });
});

describe('evalRetrieval', () => {
  it('measures recall@k and MRR with per-case ranks', async () => {
    const { base } = await fixtureBase();
    const evaluation = await evalRetrieval({ base, cases: JUDGMENTS, k: 5 });
    expect(evaluation.recallAtK).toBeGreaterThanOrEqual(0.9);
    expect(evaluation.mrr).toBeGreaterThanOrEqual(0.88);
    expect(evaluation.perCase[0]).toEqual({ query: JUDGMENTS[0]?.query, rank: 1, results: expect.arrayContaining(['install.md']) });
    const miss = await evalRetrieval({ base, cases: [{ query: 'quantum chromodynamics', relevant: ['nothing.md'] }] });
    expect(miss).toMatchObject({ recallAtK: 0, mrr: 0, perCase: [{ query: 'quantum chromodynamics' }] });
    await expect(evalRetrieval({ base, cases: [] })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
