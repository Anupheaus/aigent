import { describe, expect, it } from 'vitest';
import type { AigentEvent } from '../../../core/aigent-events.js';
import { createAigent } from '../../../core/create-aigent.js';
import { fixtureBase } from '../../../knowledge/knowledge-base.test-support.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { knowledgeTools } from './index.js';
import type { KnowledgeBase } from './index.js';

/** The base, counting the searches that reach it. */
function counted(base: KnowledgeBase): { base: KnowledgeBase; searches: () => number } {
  let searches = 0;
  return { base: { ...base, search: request => { searches += 1; return base.search(request); } }, searches: () => searches };
}

async function setup(turns: FakeTurn[]) {
  const fixture = await fixtureBase();
  const { base, searches } = counted(fixture.base);
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
  const agent = ai.agent({ name: 'librarian', model: 'fake:m', todo: false, tools: knowledgeTools({ base }) });
  return { ai, agent, provider, base, searches };
}

const search = (id: string, query: string) => toolTurn([{ id, name: 'knowledge_search', args: { items: [{ query, k: 3 }] } }]);

describe('knowledge tools in the agent loop', () => {
  it('answers from the corpus with structured citations, markers stripped and unknown ids dropped with a warning', async () => {
    const { base } = await fixtureBase();
    const [hit] = await base.search({ query: 'how long are backups kept', k: 3 });
    const chunkId = hit?.chunkId ?? '';
    const { ai, agent } = await setup([search('k1', 'how long are backups kept'), textTurn(`Backups are kept for thirty five days [[cite:${chunkId}]] [[cite:feedfacefeedface]].`)]);
    const handle = agent.task({ task: 'How long are backups kept?' });
    const events: AigentEvent[] = [];
    for await (const event of handle) events.push(event);
    const result = await handle;
    expect(result.answer).toBe('Backups are kept for thirty five days.');
    expect(result.citations).toEqual([{ sourceId: 'db-backups.md', chunkId, uri: 'docs/db-backups.md', span: hit?.span }]);
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('feedfacefeedface') });
    await ai.close();
  });

  it('puts the citation rule in the system prompt once, identically in every run', async () => {
    const { ai, agent, provider } = await setup([textTurn('one'), textTurn('two')]);
    await agent.task({ task: 'a' });
    await agent.task({ task: 'b' });
    const systems = provider.requests.map(({ messages }) => messages.find(({ role }) => role === 'system')?.text ?? '');
    expect(systems[0]?.match(/\[\[cite:<chunkId>\]\]/g)).toHaveLength(1);
    expect(systems[1]).toBe(systems[0]);
    await ai.close();
  });

  it('serves a repeated search from the cache, and searches again after the index changes', async () => {
    const { ai, agent, base, searches } = await setup([search('a', 'webhook signature'), textTurn('one'), search('b', 'webhook signature'), textTurn('two'), search('c', 'webhook signature'), textTurn('three')]);
    await agent.task({ task: 'first' });
    await agent.task({ task: 'second' });
    expect(searches()).toBe(1);
    await base.index({ sources: [{ id: 'webhooks.md', uri: 'docs/webhooks.md', text: '# Webhooks\n\nEvery delivery now carries an Ed25519 signature header.' }] });
    await agent.task({ task: 'third' });
    expect(searches()).toBe(2);
    await ai.close();
  });

  it('records citations on the chat reply meta', async () => {
    const { base } = await fixtureBase();
    const [hit] = await base.search({ query: 'webhook signature', k: 3 });
    const { ai, agent } = await setup([search('k1', 'webhook signature'), textTurn(`Deliveries are signed [[cite:${hit?.chunkId ?? ''}]].`)]);
    const chat = agent.chat();
    const reply = await chat.send('Are webhooks signed?');
    expect(reply.text).toBe('Deliveries are signed.');
    const message = chat.conversation().messages.find(({ id }) => id === reply.messageId);
    expect(message?.meta?.citations).toEqual([expect.objectContaining({ sourceId: 'webhooks.md', chunkId: hit?.chunkId })]);
    // Review M7: the stored message reads like the reply, without the raw markers.
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'Deliveries are signed.' });
    await ai.close();
  });
});
