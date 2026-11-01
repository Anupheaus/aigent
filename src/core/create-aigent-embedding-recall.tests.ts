import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Embedder } from '../knowledge/knowledge-types.js';
import { embeddingRetriever } from '../memory/embedding-retriever.js';
import type { MemoryRetriever } from '../memory/memory-types.js';
import { MEMORY_VECTOR_COLLECTION } from '../memory/memory-vectors.js';
import { conceptEmbedder } from '../memory/paraphrase-fixtures.test-support.js';
import type { ProviderRequest } from '../providers/provider-types.js';
import { createMongoFake } from '../store/mongo-fake.test-support.js';
import { createMongoStore } from '../store/mongo-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { defineGuardrail } from '../guardrails/define-guardrail.js';
import type { Guardrail } from '../guardrails/guardrail-types.js';
import { createAigent } from './create-aigent.js';
import type { IdGenerator } from './runtime-services.js';

const FACT = 'Deploy to staging with npm run deploy:staging';
const PARAPHRASE = 'Ship the app to preprod';

const lookup = defineTool({
  name: 'lookup', description: 'Look a key up', args: z.object({ key: z.string() }).strict(),
  deterministic: false, cache: false, describeActivity: args => ({ title: `Look up ${args.key}` }), run: async args => `value of ${args.key}`,
});

function sequentialIds(prefix: string): IdGenerator {
  let counter = 0;
  return { next: kind => `${prefix}${kind}_${++counter}` };
}

function runtime(params: { store: Store; turns: FakeTurn[]; prefix: string; retriever?: MemoryRetriever; guardrails?: Guardrail[] }) {
  const { store, turns, prefix, retriever, guardrails } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({
    providers: [provider], store, clock: { now: () => 5_000 }, ids: sequentialIds(prefix), enableFeedback: false, volatile: { dateTime: false },
    ...(guardrails == null ? {} : { guardrails: { custom: guardrails } }),
    memory: { scope: 'agent', ...(retriever == null ? {} : { retriever }) },
  });
  return { ai, provider, agent: ai.agent({ name: 'helper', model: 'fake:m', tools: [lookup] }) };
}

function volatileOf(request: ProviderRequest | undefined): string {
  return request?.messages.find(({ volatile }) => volatile === true)?.text ?? '';
}

async function seeded(): Promise<{ store: Store; runId: string }> {
  const store = createMongoStore({ db: createMongoFake().db });
  const { agent } = runtime({ store, prefix: 'seed', turns: [toolTurn([{ id: 'c1', name: 'lookup', args: { key: 'k', memory: [{ kind: 'fact', text: FACT, tags: null, pinned: null }] } }]), textTurn('noted')] });
  const { runId } = await agent.task({ task: 'seed' });
  return { store, runId };
}

describe('embedding recall through the agent loop (mongo store, fake driver)', () => {
  it('recalls a paraphrased fact that keyword recall misses', async () => {
    const { store } = await seeded();
    const keywords = runtime({ store, prefix: 'kw', turns: [textTurn('done')] });
    await keywords.agent.task({ task: PARAPHRASE });
    expect(volatileOf(keywords.provider.requests[0])).not.toContain(FACT);
    const embedded = runtime({ store, prefix: 'emb', turns: [textTurn('done')], retriever: embeddingRetriever({ embedder: conceptEmbedder(), store }) });
    const result = await embedded.agent.task({ task: PARAPHRASE });
    expect(result.errors).toEqual([]);
    expect(volatileOf(embedded.provider.requests[0])).toContain(FACT);
  });

  it('finishes the run with a warning, recalling by keywords, when the embedder fails', async () => {
    const { store } = await seeded();
    const broken: Embedder = { id: 'broken', dimensions: 8, embed: async () => { throw new Error('embedding service unavailable'); } };
    const { agent, provider } = runtime({ store, prefix: 'broken', turns: [textTurn('done')], retriever: embeddingRetriever({ embedder: broken, store }) });
    const run = agent.task({ task: 'deploy to staging' });
    const warnings: string[] = [];
    for await (const event of run) if (event.type === 'warning') warnings.push(event.message);
    const result = await run;
    expect(result.answer).toBe('done');
    expect(warnings).toEqual([expect.stringContaining('embedding service unavailable')]);
    expect(volatileOf(provider.requests[0])).toContain(FACT);
  });

  it('embeds the task as the input guardrails rewrote it, never the original, in a task and in a chat', async () => {
    const { store } = await seeded();
    const ssn = ['123', '45', '6789'].join('-');
    const mask = defineGuardrail({ name: 'mask-ssn', stage: 'input', check: value => (String(value).includes(ssn) ? { action: 'rewrite', value: String(value).replaceAll(ssn, '[SSN]'), note: 'masked' } : { action: 'allow' }) });
    const embedder = conceptEmbedder();
    const { agent, provider } = runtime({ store, prefix: 'masked', turns: [textTurn('done'), textTurn('done')], retriever: embeddingRetriever({ embedder, store }), guardrails: [mask] });
    await agent.task({ task: `deploy for customer with SSN ${ssn}` });
    const chat = agent.chat();
    await chat.send(`ship it for SSN ${ssn}`);
    await chat.close();
    expect(JSON.stringify(provider.requests)).not.toContain(ssn);
    expect(embedder.embedded).toContain('deploy for customer with SSN [SSN]');
    expect(embedder.embedded).toContain('ship it for SSN [SSN]');
    expect(embedder.embedded.join('\n')).not.toContain(ssn);
  });

  it('previews without side effects: only the query is embedded and no vector is written', async () => {
    const { store } = await seeded();
    const embedder = conceptEmbedder();
    const { agent } = runtime({ store, prefix: 'preview', turns: [], retriever: embeddingRetriever({ embedder, store }) });
    await agent.preview({ task: PARAPHRASE });
    expect(embedder.embedded).toEqual([PARAPHRASE]);
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toEqual([]);
  });

  it('previews by meaning with the vectors a run already stored', async () => {
    const { store } = await seeded();
    const embedder = conceptEmbedder();
    const run = runtime({ store, prefix: 'stored', turns: [textTurn('done')], retriever: embeddingRetriever({ embedder, store }) });
    await run.agent.task({ task: PARAPHRASE });
    const stored = await store.list(MEMORY_VECTOR_COLLECTION);
    embedder.embedded.length = 0;
    const preview = await run.agent.preview({ task: PARAPHRASE });
    expect(preview.memory).toContain(FACT);
    expect(embedder.embedded).toEqual([PARAPHRASE]);
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toEqual(stored);
  });

  it('purges a memory\'s vector with the run that wrote the memory', async () => {
    const { store, runId } = await seeded();
    const { ai, agent } = runtime({ store, prefix: 'purge', turns: [textTurn('done')], retriever: embeddingRetriever({ embedder: conceptEmbedder(), store }) });
    await agent.task({ task: PARAPHRASE });
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toHaveLength(1);
    await ai.purge({ runId });
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toEqual([]);
  });
});
