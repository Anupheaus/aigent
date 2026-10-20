import { describe, expect, it } from 'vitest';
import type { Tool } from '../tools/tool-types.js';
import { callTool, cacheHarness, countedTool, storedEntries } from './tool-cache.test-support.js';

const PARALLEL_REQUESTERS = 50;
const AGENTS = 5;
const SLOW_TOOL_MS = 20;
const TTL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createToolCache: hits and scopes', () => {
  it('serves an identical call from the cache, marking the step and the saved time', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({});
    const first = await callTool({ harness, tool, path: 'a.txt' });
    harness.advance(10);
    const second = await callTool({ harness, tool, path: 'a.txt' });
    expect(runs()).toBe(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.envelope).toEqual({ id: expect.any(String), tool: 'read', ok: true, result: 'contents of a.txt' });
    expect(second.savedMs).toBe(first.durationMs);
  });

  it('stores deterministic entries in the toolcache collection under the requesting agent namespace by default', async () => {
    const harness = cacheHarness();
    const { tool } = countedTool({});
    await callTool({ harness, tool, path: 'a.txt', agentName: 'writer', runId: 'run-9' });
    const [entry] = await storedEntries(harness.store);
    expect(entry?.key).toMatch(/^agent:writer::[0-9a-f]{64}$/);
    expect(entry?.value).toMatchObject({
      schemaVersion: 1, namespace: 'agent:writer:', tool: 'read', storedAt: 1_000, value: 'contents of a.txt', bytes: 19, resultTokens: 5,
      stats: { firstStoredBy: { agentName: 'writer', runId: 'run-9' }, totalHits: 0, missCount: 1 },
    });
    expect(entry?.value.expiresAt).toBeUndefined();
  });

  it('shares deterministic entries between instances of one agent, but not with other agents by default (review I1)', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({});
    await callTool({ harness, tool, path: 'a.txt', agentName: 'one', instanceId: 'i1' });
    const sameAgent = await callTool({ harness, tool, path: 'a.txt', agentName: 'one', instanceId: 'i2' });
    const otherAgent = await callTool({ harness, tool, path: 'a.txt', agentName: 'two', instanceId: 'i3' });
    expect(sameAgent.cacheHit).toBe(true);
    expect(otherAgent.cacheHit).toBe(false);
    expect(runs()).toBe(2);
  });

  it('never serves one agent same-named tool bound to other data to another agent (review E4)', async () => {
    const harness = cacheHarness();
    const repoA = countedTool({ result: path => `/repoA/${path}` });
    const repoB = countedTool({ result: path => `/repoB/${path}` });
    await callTool({ harness, tool: repoA.tool, path: 'x', agentName: 'agent-a' });
    const fromB = await callTool({ harness, tool: repoB.tool, path: 'x', agentName: 'agent-b' });
    expect(fromB.envelope).toMatchObject({ ok: true, result: '/repoB/x' });
  });

  it('shares deterministic entries between agents only when the tool opts in with sharedCache or a common cacheNamespace', async () => {
    const harness = cacheHarness();
    const shared = countedTool({ overrides: { sharedCache: true } });
    await callTool({ harness, tool: shared.tool, path: 'a.txt', agentName: 'one' });
    expect((await callTool({ harness, tool: shared.tool, path: 'a.txt', agentName: 'two' })).cacheHit).toBe(true);
    const namespaced = countedTool({ overrides: { cacheNamespace: 'repo-a' } });
    const otherNamespace = countedTool({ overrides: { cacheNamespace: 'repo-b' } });
    await callTool({ harness, tool: namespaced.tool, path: 'b.txt', agentName: 'one' });
    expect((await callTool({ harness, tool: namespaced.tool, path: 'b.txt', agentName: 'two' })).cacheHit).toBe(true);
    expect((await callTool({ harness, tool: otherNamespace.tool, path: 'b.txt', agentName: 'one' })).cacheHit).toBe(false);
    const keys = (await storedEntries(harness.store)).map(({ key }) => key.split(':')[0]).sort();
    expect(keys).toEqual(['global', 'ns', 'ns']);
  });

  it('keeps two definitions of a non-deterministic tool apart within one instance', async () => {
    const harness = cacheHarness();
    const first = countedTool({ result: () => 'first', overrides: { deterministic: false, cacheTtlMs: TTL_MS } });
    const second = countedTool({ result: () => 'second', overrides: { deterministic: false, cacheTtlMs: TTL_MS } });
    await callTool({ harness, tool: first.tool, path: 'a.txt' });
    expect((await callTool({ harness, tool: second.tool, path: 'a.txt' })).envelope).toMatchObject({ result: 'second' });
  });

  it('keeps a non-deterministic cached result private to its instance, even for the same agent name', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ overrides: { deterministic: false, cacheTtlMs: TTL_MS } });
    await callTool({ harness, tool, path: 'a.txt', agentName: 'same', instanceId: 'i1' });
    const elsewhere = await callTool({ harness, tool, path: 'a.txt', agentName: 'same', instanceId: 'i2' });
    const again = await callTool({ harness, tool, path: 'a.txt', agentName: 'same', instanceId: 'i1' });
    expect(elsewhere.cacheHit).toBe(false);
    expect(again.cacheHit).toBe(true);
    expect(runs()).toBe(2);
    expect((await storedEntries(harness.store)).map(({ key }) => key.split(':')[1]).sort()).toEqual(['i1', 'i2']);
  });

  it('honours the TTL with the injected clock', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ overrides: { deterministic: false, cacheTtlMs: TTL_MS } });
    await callTool({ harness, tool, path: 'a.txt' });
    harness.advance(TTL_MS - 1);
    expect((await callTool({ harness, tool, path: 'a.txt' })).cacheHit).toBe(true);
    harness.advance(1);
    expect((await callTool({ harness, tool, path: 'a.txt' })).cacheHit).toBe(false);
    expect(runs()).toBe(2);
    const [entry] = await storedEntries(harness.store);
    expect(entry?.value).toMatchObject({ storedAt: 1_000 + TTL_MS, expiresAt: 1_000 + 2 * TTL_MS, stats: { missCount: 2, invalidationCount: 0, totalHits: 1 } });
  });
});

describe('createToolCache: validity, failures and copies', () => {
  it('never serves an entry whose validity token changed, counts the invalidation and replaces it', async () => {
    const harness = cacheHarness();
    let mtime = 'm1';
    const { tool, runs } = countedTool({ result: (path, run) => `${path} v${run}`, overrides: { validity: async () => mtime } });
    await callTool({ harness, tool, path: 'a.txt' });
    mtime = 'm2';
    const afterChange = await callTool({ harness, tool, path: 'a.txt' });
    const repeat = await callTool({ harness, tool, path: 'a.txt' });
    expect(afterChange.cacheHit).toBe(false);
    expect(afterChange.envelope).toMatchObject({ result: 'a.txt v2' });
    expect(repeat).toMatchObject({ cacheHit: true, envelope: { result: 'a.txt v2' } });
    expect(runs()).toBe(2);
    const entries = await storedEntries(harness.store);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toMatchObject({ validity: 'm2', stats: { missCount: 2, invalidationCount: 1, totalHits: 1 } });
  });

  it('runs the tool without caching when computing the validity token throws', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ overrides: { validity: async () => { throw new Error('stat failed'); } } });
    const first = await callTool({ harness, tool, path: 'a.txt' });
    await callTool({ harness, tool, path: 'a.txt' });
    expect(first.envelope.ok).toBe(true);
    expect(runs()).toBe(2);
    expect(await storedEntries(harness.store)).toEqual([]);
  });

  it('never caches failures', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ result: (path, run) => { if (run === 1) throw new Error('flaky'); return path; } });
    const failed = await callTool({ harness, tool, path: 'a.txt' });
    const retried = await callTool({ harness, tool, path: 'a.txt' });
    const served = await callTool({ harness, tool, path: 'a.txt' });
    expect(failed.envelope.ok).toBe(false);
    expect(retried).toMatchObject({ cacheHit: false, envelope: { ok: true } });
    expect(served.cacheHit).toBe(true);
    expect(runs()).toBe(2);
  });

  it('never caches results over maxEntryBytes', async () => {
    const harness = cacheHarness({ maxEntryBytes: 10 });
    const { tool, runs } = countedTool({ result: () => 'x'.repeat(100) });
    await callTool({ harness, tool, path: 'a.txt' });
    expect((await callTool({ harness, tool, path: 'a.txt' })).cacheHit).toBe(false);
    expect(runs()).toBe(2);
  });

  it('never caches a tool with side effects, even one built by hand with cache set', async () => {
    const harness = cacheHarness();
    const counted = countedTool({});
    const sideEffecting: Tool = { ...counted.tool, hasSideEffects: true, deterministic: false };
    const first = await callTool({ harness, tool: sideEffecting, path: 'a.txt' });
    await callTool({ harness, tool: sideEffecting, path: 'a.txt' });
    expect(counted.runs()).toBe(2);
    expect(first.cacheHit).toBeUndefined();
    expect(await storedEntries(harness.store)).toEqual([]);
  });

  it('returns deep copies: mutating a returned or original result never changes later hits', async () => {
    const harness = cacheHarness();
    const shared = { list: [1] };
    const { tool } = countedTool({ result: () => shared });
    const first = await callTool({ harness, tool, path: 'a.txt' });
    shared.list.push(9);
    (first.envelope as { result: { list: number[] } }).result.list.push(2);
    const hit = await callTool({ harness, tool, path: 'a.txt' });
    (hit.envelope as { result: { list: number[] } }).result.list.push(3);
    const later = await callTool({ harness, tool, path: 'a.txt' });
    expect(later.envelope).toMatchObject({ result: { list: [1] } });
  });
});

describe('createToolCache: concurrency and eviction', () => {
  it('executes identical concurrent calls once and counts every hit exactly, per agent', async () => {
    const harness = cacheHarness();
    // Shared, so the requesters of every agent meet in one entry.
    const { tool, runs } = countedTool({ result: async path => { await delay(SLOW_TOOL_MS); return path; }, overrides: { sharedCache: true } });
    const calls = Array.from({ length: PARALLEL_REQUESTERS }, (_unused, requester) => callTool({ harness, tool, path: 'a.txt', agentName: `agent-${requester % AGENTS}` }));
    const executed = await Promise.all(calls);
    expect(runs()).toBe(1);
    expect(executed.filter(({ cacheHit }) => cacheHit === true)).toHaveLength(PARALLEL_REQUESTERS - 1);
    expect(executed.every(({ envelope }) => envelope.ok)).toBe(true);
    const [entry] = await storedEntries(harness.store);
    const { stats } = entry!.value;
    expect(stats.totalHits).toBe(PARALLEL_REQUESTERS - 1);
    expect(stats.missCount).toBe(1);
    expect(Object.values(stats.hitsByAgent).reduce((sum, hits) => sum + hits, 0)).toBe(stats.totalHits);
    expect(Object.keys(stats.hitsByAgent)).toHaveLength(AGENTS);
  });

  it('lets waiting callers run the tool themselves when the first call fails', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ result: async (path, run) => { await delay(SLOW_TOOL_MS); if (run === 1) throw new Error('flaky'); return path; } });
    const executed = await Promise.all([callTool({ harness, tool, path: 'a.txt' }), callTool({ harness, tool, path: 'a.txt' })]);
    expect(executed.map(({ envelope }) => envelope.ok)).toEqual([false, true]);
    expect(runs()).toBe(2);
  });

  it('evicts the least recently requested entry beyond maxEntries', async () => {
    const harness = cacheHarness({ maxEntries: 2 });
    const { tool, runs } = countedTool({});
    await callTool({ harness, tool, path: 'a' });
    harness.advance(1);
    await callTool({ harness, tool, path: 'b' });
    harness.advance(1);
    await callTool({ harness, tool, path: 'a' });
    harness.advance(1);
    await callTool({ harness, tool, path: 'c' });
    expect(runs()).toBe(3);
    expect((await callTool({ harness, tool, path: 'a' })).cacheHit).toBe(true);
    expect((await callTool({ harness, tool, path: 'c' })).cacheHit).toBe(true);
    expect((await callTool({ harness, tool, path: 'b' })).cacheHit).toBe(false);
    const evicted = (await storedEntries(harness.store)).filter(({ value }) => value.evicted === true);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.value).toMatchObject({ value: null, bytes: 0, stats: { missCount: 1 } });
  });

  it('evicts the least recently requested entries beyond maxBytes', async () => {
    // Each result serialises to 42 bytes, so two fit in 100 and a third evicts the oldest.
    const harness = cacheHarness({ maxBytes: 100 });
    const { tool } = countedTool({ result: path => path.repeat(40) });
    await callTool({ harness, tool, path: 'a' });
    harness.advance(1);
    await callTool({ harness, tool, path: 'b' });
    harness.advance(1);
    await callTool({ harness, tool, path: 'c' });
    expect((await callTool({ harness, tool, path: 'a' })).cacheHit).toBe(false);
    expect((await callTool({ harness, tool, path: 'c' })).cacheHit).toBe(true);
  });
});

describe('createToolCache.findings', () => {
  it('reports the hottest entries and hit rates per tool and agent', async () => {
    const harness = cacheHarness();
    const { tool } = countedTool({ overrides: { sharedCache: true } });
    await callTool({ harness, tool, path: 'hot', agentName: 'one' });
    for (let repeat = 0; repeat < 3; repeat += 1) await callTool({ harness, tool, path: 'hot', agentName: 'two' });
    await callTool({ harness, tool, path: 'cold', agentName: 'one' });
    const findings = await harness.cache.findings();
    expect(findings.hottest).toEqual([{ tool: 'read', key: expect.stringMatching(/^global:/), hits: 3, savedMs: 0 }]);
    expect(findings.hitRateByTool).toEqual({ read: 3 / 5 });
    expect(findings.hitRateByAgent).toEqual({ one: 0, two: 1 });
    expect(findings.worthMarkingDeterministic).toEqual([]);
  });
});
