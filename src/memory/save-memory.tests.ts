import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { Redact } from '../telemetry/redact.js';
import { memoryId } from './dedupe.js';
import { saveMemory } from './save-memory.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, MemoryNote, ResolvedMemoryOptions } from './memory-types.js';

const DAY_MS = 86_400_000;
const NOW = 50 * DAY_MS;
const OPTIONS: ResolvedMemoryOptions = { scope: 'agent', maxEntries: 200, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };
const SOURCE = { runId: 'run_1', callId: 'call_1', origin: 'tool-call' as const };

interface SaveParams {
  store: Store;
  notes: MemoryNote[];
  options?: Partial<ResolvedMemoryOptions>;
  redact?: Redact;
  scopeKey?: string;
  agentName?: string;
  now?: number;
}

function save(params: SaveParams) {
  const { store, notes, options = {}, redact, scopeKey = 'agent', agentName = 'helper', now = NOW } = params;
  return saveMemory({ store, ...(redact == null ? {} : { redact }), options: { ...OPTIONS, ...options }, now, request: { agentName, scopeKey, notes, source: SOURCE } });
}

async function stored(store: Store): Promise<MemoryEntry[]> {
  return (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
}

/** A store without the optional `delete`, so eviction must leave tombstones. */
function storeWithoutDelete(): Store {
  const { get, compareAndSet, list } = createInMemoryStore();
  return { get, compareAndSet, list };
}

describe('saveMemory', () => {
  it('writes a new note with the defaults', async () => {
    const store = createInMemoryStore();
    const result = await save({ store, notes: [{ kind: 'fact', text: 'Tests live in src', tags: ['tests', 'tests'] }] });
    expect(result).toEqual({ saved: 1, evicted: 0, problems: [] });
    const id = memoryId({ agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'Tests live in src' });
    expect(await stored(store)).toEqual([{
      id, agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'Tests live in src', tags: ['tests'], source: SOURCE,
      confidence: 0.6, pinned: false, uses: 0, createdAt: NOW, updatedAt: NOW, recordedAt: NOW,
    }]);
  });

  it('merges a repeat into the same entry instead of adding one', async () => {
    const store = createInMemoryStore();
    await save({ store, notes: [{ kind: 'fact', text: 'Tests live in src' }] });
    await save({ store, notes: [{ kind: 'fact', text: '  tests LIVE in src ' }], now: NOW + 1 });
    const entries = await stored(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ confidence: 0.7, createdAt: NOW, updatedAt: NOW + 1, text: 'Tests live in src' });
  });

  it('keeps one scope and one agent apart', async () => {
    const store = createInMemoryStore();
    const note: MemoryNote = { kind: 'fact', text: 'Tests live in src' };
    await save({ store, notes: [note] });
    await save({ store, notes: [note], scopeKey: 'session:s1' });
    await save({ store, notes: [note], agentName: 'other' });
    expect((await stored(store)).map(({ agentName, scopeKey, confidence }) => `${agentName}/${scopeKey}/${confidence}`).sort()).toEqual(['helper/agent/0.6', 'helper/session:s1/0.6', 'other/agent/0.6']);
  });

  it('evicts the lowest-scoring entry of the same agent and scope past the cap', async () => {
    const store = createInMemoryStore();
    await save({ store, notes: [{ kind: 'fact', text: 'old and unused' }], now: NOW - 90 * DAY_MS });
    await save({ store, notes: [{ kind: 'fact', text: 'recent' }], now: NOW - DAY_MS });
    await save({ store, notes: [{ kind: 'fact', text: 'other scope' }], scopeKey: 'session:s1', now: NOW - 300 * DAY_MS });
    const result = await save({ store, notes: [{ kind: 'fact', text: 'new' }], options: { maxEntries: 2 } });
    expect(result).toEqual({ saved: 1, evicted: 1, problems: [] });
    expect((await stored(store)).map(({ text }) => text).sort()).toEqual(['new', 'other scope', 'recent']);
  });

  it('keeps the cap even when pinned entries fill it: unpinned entries go first, then the weakest pinned', async () => {
    const store = createInMemoryStore();
    await save({ store, notes: [{ kind: 'fact', text: 'pinned one', pinned: true }, { kind: 'fact', text: 'pinned two', pinned: true }], now: NOW - 300 * DAY_MS });
    const result = await save({ store, notes: [{ kind: 'fact', text: 'new' }], options: { maxEntries: 1 } });
    expect(result).toEqual({ saved: 1, evicted: 2, problems: [] });
    const entries = await stored(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pinned).toBe(true);
  });

  it('leaves tombstones on a store without delete, and they no longer count against the cap', async () => {
    const store = storeWithoutDelete();
    await save({ store, notes: [{ kind: 'fact', text: 'oldest' }], now: NOW - 200 * DAY_MS });
    await save({ store, notes: [{ kind: 'fact', text: 'middle' }], now: NOW - 100 * DAY_MS, options: { maxEntries: 1 } });
    const result = await save({ store, notes: [{ kind: 'fact', text: 'newest' }], options: { maxEntries: 1 } });
    expect(result.evicted).toBe(1);
    const entries = await stored(store);
    expect(entries.filter(({ removed }) => removed == null).map(({ text }) => text)).toEqual(['newest']);
    expect(entries.filter(({ removed }) => removed != null).map(({ text, removed }) => `${text}:${removed?.reason}`).sort()).toEqual(['middle:evicted', 'oldest:evicted']);
  });

  it('stores what redact returns, keeping the identity fields its own', async () => {
    const store = createInMemoryStore();
    const redact: Redact = record => {
      const value = record.value as MemoryEntry;
      return { ...record, value: { ...value, text: value.text.replace('hunter2', '[secret]'), agentName: 'tampered' } };
    };
    await save({ store, notes: [{ kind: 'fact', text: 'The password is hunter2' }], redact });
    const [entry] = await stored(store);
    expect(entry).toMatchObject({ text: 'The password is [secret]', agentName: 'helper', scopeKey: 'agent' });
  });

  it('redacts secrets from note text before anything is stored, whatever the redact hook does', async () => {
    const store = createInMemoryStore();
    const key = ['sk-proj-', 'AbCdEfGhIjKlMnOpQrStUvWx0123456789'].join('');
    const result = await save({ store, notes: [{ kind: 'fact', text: `Deploy key for billing is ${key}` }] });
    expect(result).toEqual({ saved: 1, evicted: 0, problems: [] });
    expect((await stored(store)).map(({ text }) => text)).toEqual(['Deploy key for billing is [REDACTED:api-key]']);
    expect(JSON.stringify(await store.list(MEMORY_COLLECTION))).not.toContain(key);
  });

  it('redacts personal data from note text only when asked to', async () => {
    const email = ['jane.doe', 'example.com'].join('@');
    const kept = createInMemoryStore();
    await save({ store: kept, notes: [{ kind: 'fact', text: `Send the report to ${email}` }] });
    expect((await stored(kept)).map(({ text }) => text)).toEqual([`Send the report to ${email}`]);
    const redacted = createInMemoryStore();
    await saveMemory({ store: redacted, redactsPii: true, options: OPTIONS, now: NOW, request: { agentName: 'helper', scopeKey: 'agent', notes: [{ kind: 'fact', text: `Send the report to ${email}` }], source: SOURCE } });
    expect((await stored(redacted)).map(({ text }) => text)).toEqual(['Send the report to [REDACTED:email]']);
  });

  it('keys an entry on the text as stored: never a hash of a secret, and notes that redact alike are one entry', async () => {
    const store = createInMemoryStore();
    const keys = ['AbCdEfGhIjKlMnOpQrStUvWx0123456789', 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210'].map(tail => ['sk-proj-', tail].join(''));
    await save({ store, notes: [{ kind: 'fact', text: `Deploy key is ${keys[0]}` }] });
    await save({ store, notes: [{ kind: 'fact', text: `Deploy key is ${keys[1]}` }], now: NOW + 1 });
    const entries = await stored(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ confidence: 0.7, text: 'Deploy key is [REDACTED:api-key]' });
    expect(entries[0]?.id).toBe(memoryId({ agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'Deploy key is [REDACTED:api-key]' }));
  });

  it('keys an entry on the text the redact hook left', async () => {
    const store = createInMemoryStore();
    const redact: Redact = record => ({ ...record, value: { ...record.value as MemoryEntry, text: (record.value as MemoryEntry).text.replace(/hunter\d/, '[secret]') } });
    await save({ store, notes: [{ kind: 'fact', text: 'The password is hunter2' }, { kind: 'fact', text: 'The password is hunter3' }], redact });
    const entries = await stored(store);
    expect(entries.map(({ id, text }) => ({ id, text }))).toEqual([{ id: memoryId({ agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'The password is [secret]' }), text: 'The password is [secret]' }]);
  });

  it('skips a note whose redact throws, saving the others', async () => {
    const store = createInMemoryStore();
    const redact: Redact = record => {
      if ((record.value as MemoryEntry).text.includes('boom')) throw new Error('cannot redact');
      return record;
    };
    const result = await save({ store, notes: [{ kind: 'fact', text: 'boom' }, { kind: 'fact', text: 'fine' }], redact });
    expect(result.saved).toBe(1);
    expect(result.problems).toEqual(['memory note 1 was not saved: cannot redact']);
    expect((await stored(store)).map(({ text }) => text)).toEqual(['fine']);
  });

  it('reports a failed store write for the note it concerns', async () => {
    const base = createInMemoryStore();
    const failing: Store = { ...base, compareAndSet: async () => { throw new Error('disk full'); } };
    const result = await save({ store: failing, notes: [{ kind: 'fact', text: 'x' }] });
    expect(result).toEqual({ saved: 0, evicted: 0, problems: ['memory note 1 was not saved: disk full'] });
  });
});
