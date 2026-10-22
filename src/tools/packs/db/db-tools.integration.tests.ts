import { describe, expect, it } from 'vitest';
import { createAigent } from '../../../core/create-aigent.js';
import type { AigentOptions } from '../../../core/aigent-types.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { createDbPolicy, dbTools } from './index.js';
import type { DbToolsOptions } from './index.js';
import { fixtureAccess } from './db-tools.test-support.js';

function setup(params: { turns: FakeTurn[]; now?: { value: number }; options?: Partial<AigentOptions>; tools?: Partial<DbToolsOptions> }) {
  const { turns, now = { value: 1_000 }, options = {}, tools = {} } = params;
  const access = fixtureAccess();
  const policy = createDbPolicy({ collections: { people: { permissions: ['read'], denyFields: ['password', 'profile.ssn'] }, audit: { permissions: ['read'], requiresApproval: true } } });
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false, clock: { now: () => now.value }, ...options });
  const agent = ai.agent({ name: 'analyst', model: 'fake:m', todo: false, tools: dbTools({ policy, access, ...tools }) });
  return { ai, agent, provider, access };
}

const query = (id: string, items: unknown[]) => toolTurn([{ id, name: 'db_query', args: { items } }]);
const seenBy = (provider: ReturnType<typeof createFakeProvider>, callId: string) => JSON.parse(provider.requests.flatMap(({ messages }) => messages).find(({ toolCallId }) => toolCallId === callId)?.text ?? '{}');

describe('db_query in the agent loop', () => {
  it('serves a repeated query from the cache within 30 seconds, then queries again', async () => {
    const now = { value: 1_000 };
    const ask = (id: string) => query(id, [{ collection: 'people', filter: '{"age":{"$gt":20}}' }]);
    const { ai, agent, access } = setup({ now, turns: [ask('a'), textTurn('one'), ask('b'), textTurn('two'), ask('c'), textTurn('three')] });
    await agent.task({ task: 'who is over 20?' });
    now.value += 10_000;
    await agent.task({ task: 'again' });
    expect(access.calls).toHaveLength(1);
    now.value += 30_001;
    await agent.task({ task: 'later' });
    expect(access.calls).toHaveLength(2);
    await ai.close();
  });

  it('queries every time when the cache is off', async () => {
    const ask = (id: string) => query(id, [{ collection: 'people' }]);
    const { ai, agent, access } = setup({ turns: [ask('a'), ask('b'), textTurn('done')], tools: { cacheTtlMs: false } });
    await agent.task({ task: 'twice' });
    expect(access.calls).toHaveLength(2);
    await ai.close();
  });

  it('runs unattended without approval (read-only), but refuses a sensitive collection unless an allow rule grants it', async () => {
    const plain = setup({ turns: [query('q1', [{ collection: 'people', projection: ['name', 'age'] }]), textTurn('done')] });
    await plain.agent.task({ task: 'list people', unattended: true });
    expect(seenBy(plain.provider, 'q1')).toMatchObject({ ok: true });
    await plain.ai.close();
    const denied = setup({ turns: [query('q1', [{ collection: 'audit' }]), textTurn('done')] });
    await denied.agent.task({ task: 'read the audit log', unattended: true });
    expect(seenBy(denied.provider, 'q1')).toMatchObject({ ok: false, error: { code: 'approval_denied' } });
    expect(denied.access.calls).toEqual([]);
    await denied.ai.close();
    const granted = setup({ turns: [query('q1', [{ collection: 'audit' }]), textTurn('done')], options: { approvals: { allow: [{ tool: 'db_query' }] } } });
    await granted.agent.task({ task: 'read the audit log', unattended: true });
    expect(granted.access.calls).toHaveLength(1);
    await granted.ai.close();
  });

  it('shows flat documents to the model as columns and rows, with the full result under a handle', async () => {
    const { ai, agent, provider } = setup({ turns: [query('q1', [{ collection: 'people', projection: ['name', 'age'], sort: [{ field: 'age', direction: 'asc' }] }]), textTurn('done')] });
    await agent.task({ task: 'list people' });
    const seen = seenBy(provider, 'q1');
    expect(seen.result.result[0].result.docs).toEqual({ columns: ['_id', 'name', 'age'], rows: [[2, 'Bob', 19], [1, 'Ann', 34], [3, 'Cy', 51]] });
    expect(seen.result.shaping[0]).toMatchObject({ shaper: 'tabular', handle: expect.any(String) });
    await ai.close();
  });
});
